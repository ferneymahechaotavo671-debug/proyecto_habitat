"use strict";
const express    = require("express");
const mysql      = require("mysql2/promise");
const path       = require("path");
const ExcelJS    = require("exceljs");
const cron       = require("node-cron");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 8080;

// ─────────────────────────────────────────
// SEGURIDAD: password SOLO en servidor
// ─────────────────────────────────────────
const PASSWORD_ADMIN = process.env.ADMIN_PASSWORD || "Habitat2026";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "publico")));

// ─────────────────────────────────────────
// MEJORA #2: Pool en vez de createConnection
// Reconexión automática, manejo de concurrencia
// ─────────────────────────────────────────
const pool = mysql.createPool({
  host               : process.env.MYSQLHOST,
  user               : process.env.MYSQLUSER,
  password           : process.env.MYSQLPASSWORD,
  database           : process.env.MYSQLDATABASE,
  port               : process.env.MYSQLPORT,
  waitForConnections : true,
  connectionLimit    : 10,
  timezone           : "+00:00",   // MEJORA #8: siempre UTC
  decimalNumbers     : true,
});

// Test de conexión al arrancar
pool.getConnection()
  .then(conn => { console.log("✅ MySQL pool conectado"); conn.release(); })
  .catch(err  => console.error("❌ Error DB:", err.message));

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function normalizar(t) {
  return (t || "").toString().toLowerCase().trim()
    .replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
}

// MEJORA #12: log de auditoría
async function auditLog(accion, detalle, cedula = null) {
  try {
    await pool.execute(
      "INSERT INTO audit_log (accion, detalle, cedula, fecha) VALUES (?,?,?,UTC_TIMESTAMP())",
      [accion, JSON.stringify(detalle), cedula]
    );
  } catch { /* silencioso, no bloquear flujo */ }
}

// ─────────────────────────────────────────
// MIDDLEWARE: validar admin (solo servidor)
// ─────────────────────────────────────────
function validarAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== PASSWORD_ADMIN) {
    return res.status(403).json({ mensaje: "Acceso denegado 🔒" });
  }
  next();
}

// ─────────────────────────────────────────
// MANEJO GLOBAL DE ERRORES ASYNC
// ─────────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────
app.post("/login", (req, res) => {
  if (req.body.password === PASSWORD_ADMIN) return res.json({ ok: true });
  res.status(401).json({ ok: false, mensaje: "Contraseña incorrecta" });
});

// ─────────────────────────────────────────
// EDIFICIOS
// ─────────────────────────────────────────
app.get("/admin/edificios", asyncHandler(async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM edificios ORDER BY nombre ASC");
  res.json(rows);
}));

app.post("/admin/agregar-edificio", validarAdmin, asyncHandler(async (req, res) => {
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ mensaje: "Nombre requerido" });
  const codigo_qr = normalizar(nombre);
  await pool.execute("INSERT INTO edificios (nombre, codigo_qr) VALUES (?,?)", [nombre.trim(), codigo_qr]);
  await auditLog("agregar_edificio", { nombre, codigo_qr });
  res.json({ ok: true });
}));

app.post("/admin/editar-edificio", validarAdmin, asyncHandler(async (req, res) => {
  const { id, nombre } = req.body;
  await pool.execute(
    "UPDATE edificios SET nombre=?, codigo_qr=? WHERE id=?",
    [nombre, normalizar(nombre), id]
  );
  await auditLog("editar_edificio", { id, nombre });
  res.json({ ok: true });
}));

// ─────────────────────────────────────────
// USUARIOS
// ─────────────────────────────────────────
app.post("/admin/crear-usuario", validarAdmin, asyncHandler(async (req, res) => {
  const { nombre, cedula, rol_id } = req.body;
  if (!nombre || !cedula) return res.status(400).json({ mensaje: "Datos incompletos" });
  await pool.execute(
    "INSERT INTO usuarios (nombre, cedula, rol_id) VALUES (?,?,?)",
    [nombre, cedula, rol_id]
  );
  await auditLog("crear_usuario", { nombre, cedula, rol_id });
  res.json({ ok: true });
}));

app.post("/admin/editar-usuario", validarAdmin, asyncHandler(async (req, res) => {
  const { id, nombre, cedula, rol_id } = req.body;
  await pool.execute(
    "UPDATE usuarios SET nombre=?, cedula=?, rol_id=? WHERE id=?",
    [nombre, cedula, rol_id, id]
  );
  await auditLog("editar_usuario", { id, nombre, cedula });
  res.json({ ok: true });
}));

// ─────────────────────────────────────────
// DISPOSITIVOS
// ─────────────────────────────────────────
app.get("/admin/dispositivos", validarAdmin, asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT d.id, u.nombre, d.cedula, d.device_id, d.autorizado,
           e.nombre AS edificio, e.id AS edificio_id,
           IFNULL(r.nombre,'usuario') AS rol
    FROM dispositivos d
    LEFT JOIN usuarios u  ON d.cedula      = u.cedula
    LEFT JOIN edificios e ON d.edificio_id = e.id
    LEFT JOIN roles r     ON u.rol_id      = r.id
    ORDER BY d.id DESC
  `);

  const [totalEdificios] = await pool.execute("SELECT COUNT(*) AS n FROM edificios");
  const numEdificios = totalEdificios[0]?.n || 0;

  // MEJORA: si una cédula de rol Administración tiene fila en TODOS los
  // edificios, se colapsan en una sola fila virtual "Todos los edificios"
  // para no saturar el panel con un registro por edificio.
  const porCedula = new Map();
  rows.forEach(d => {
    if (!porCedula.has(d.cedula)) porCedula.set(d.cedula, []);
    porCedula.get(d.cedula).push(d);
  });

  const resultado = [];
  porCedula.forEach(filas => {
    const esAdmin = filas[0]?.rol === "Administración";
    if (esAdmin && numEdificios > 0 && filas.length >= numEdificios) {
      const base = filas[0];
      resultado.push({
        id          : base.id,
        nombre      : base.nombre,
        cedula      : base.cedula,
        device_id   : base.device_id,
        autorizado  : filas.every(f => f.autorizado == 1) ? 1 : 0,
        edificio    : "Todos los edificios",
        rol         : base.rol,
        _ids_agrupados: filas.map(f => f.id),
      });
    } else {
      resultado.push(...filas);
    }
  });

  resultado.sort((a, b) => b.id - a.id);
  res.json(resultado);
}));

app.post("/admin/aprobar-dispositivo", validarAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.id];
  await pool.query("UPDATE dispositivos SET autorizado=1 WHERE id IN (?)", [ids]);
  await auditLog("aprobar_dispositivo", { ids });
  res.json({ ok: true });
}));

app.post("/admin/bloquear-dispositivo", validarAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.id];
  await pool.query("UPDATE dispositivos SET autorizado=0 WHERE id IN (?)", [ids]);
  await auditLog("bloquear_dispositivo", { ids });
  res.json({ ok: true });
}));

app.post("/admin/agregar-dispositivo", validarAdmin, asyncHandler(async (req, res) => {
  const { cedula, device_id, edificio_ids } = req.body;

  let ids;
  if (edificio_ids === "todos") {
    const [rows] = await pool.execute("SELECT id FROM edificios");
    ids = rows.map(r => r.id);
  } else {
    ids = Array.isArray(edificio_ids) ? edificio_ids : [edificio_ids];
  }

  for (const edificio_id of ids) {
    const [existing] = await pool.execute(
      "SELECT id FROM dispositivos WHERE cedula=? AND edificio_id=? LIMIT 1",
      [cedula, edificio_id]
    );
    if (existing.length > 0) {
      await pool.execute(
        "UPDATE dispositivos SET device_id=?, autorizado=1 WHERE id=?",
        [device_id || "", existing[0].id]
      );
    } else {
      await pool.execute(
        "INSERT INTO dispositivos (cedula, device_id, edificio_id, autorizado) VALUES (?,?,?,1)",
        [cedula, device_id || "", edificio_id]
      );
    }
  }

  await auditLog("agregar_dispositivo", { cedula, edificio_ids });
  res.json({ ok: true });
}));

app.post("/admin/asignar-edificio", validarAdmin, asyncHandler(async (req, res) => {
  await pool.execute(
    "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?,?,?)",
    [req.body.cedula, "", req.body.edificio_id]
  );
  res.json({ ok: true });
}));

app.post("/admin/quitar-permiso", validarAdmin, asyncHandler(async (req, res) => {
  await pool.execute(
    "DELETE FROM dispositivos WHERE cedula=? AND edificio_id=?",
    [req.body.cedula, req.body.edificio_id]
  );
  res.json({ ok: true });
}));

// ─────────────────────────────────────────
// REGISTROS con alerta 12h
// MEJORA #3: params siempre parametrizados (no concatenación)
// MEJORA #9: paginación
// ─────────────────────────────────────────
app.get("/admin/registros", validarAdmin, asyncHandler(async (req, res) => {
  const conditions = ["1=1"];
  const params     = [];

  // MEJORA #3: nunca concatenar — siempre ? 
  if (req.query.edificio_id) {
    const eid = parseInt(req.query.edificio_id, 10);
    if (!isNaN(eid)) { conditions.push("edificio_id=?"); params.push(eid); }
  }
  if (req.query.cedula) {
    // solo dígitos
    const ced = req.query.cedula.replace(/\D/g, "");
    if (ced) { conditions.push("cedula=?"); params.push(ced); }
  }
  if (req.query.fecha_desde) {
    conditions.push("fecha_hora >= ?");
    params.push(req.query.fecha_desde + " 00:00:00");
  }
  if (req.query.fecha_hasta) {
    conditions.push("fecha_hora <= ?");
    params.push(req.query.fecha_hasta + " 23:59:59");
  }

  // MEJORA #9: paginación
  const limit  = Math.min(parseInt(req.query.limit  || "100", 10), 500);
  const offset = parseInt(req.query.offset || "0", 10);

  const where = conditions.join(" AND ");

  // Para calcular alertas necesitamos todos (sin límite), pero solo IDs
  const [todos] = await pool.execute(
    `SELECT id, cedula, edificio_id, tipo_registro, fecha_hora FROM registros WHERE ${where} ORDER BY fecha_hora ASC`,
    params
  );

  const ahora = new Date();
  const entradasActivas = new Map();

  todos.forEach(r => {
    const clave = `${r.cedula}_${r.edificio_id}`;
    if (r.tipo_registro === "Entrada") {
      entradasActivas.set(clave, { id: r.id, fecha: new Date(r.fecha_hora) });
    } else if (r.tipo_registro === "Salida") {
      entradasActivas.delete(clave);
    }
  });

  const idsEnAlerta = new Set();
  entradasActivas.forEach(entrada => {
    if ((ahora - entrada.fecha) / 3_600_000 > 12) idsEnAlerta.add(entrada.id);
  });

  // Ahora traer la página con todos los campos
  // NOTA: LIMIT/OFFSET con pool.execute (prepared statement binario) puede fallar
  // en mysql2 ("Argumentos incorrectos para mysqld_stmt_execute"); se usa pool.query
  // para esta consulta puntual, con limit/offset ya validados como enteros arriba.
  const [pagina] = await pool.query(
    `SELECT * FROM registros WHERE ${where} ORDER BY fecha_hora DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  // Contar total para paginación en cliente
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM registros WHERE ${where}`,
    params
  );

  const procesado = pagina.map(r => ({
    ...r,
    observacion: idsEnAlerta.has(r.id) ? "🚨 Salida no registrada" : (r.observacion || ""),
  }));

  res.json({ registros: procesado, total, limit, offset });
}));

// ─────────────────────────────────────────
// REGISTRO QR — MEJORA #6: async/await lineal
// ─────────────────────────────────────────
app.post("/registro", asyncHandler(async (req, res) => {
  const cedula        = req.body.cedula?.toString().trim();
  const codigoEdificio = normalizar(req.body.codigoEdificio);
  const deviceId      = req.body.deviceId;

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  // 1. Buscar edificio
  const [edificios] = await pool.execute("SELECT * FROM edificios");
  const edificio = edificios.find(e => normalizar(e.codigo_qr) === codigoEdificio);
  if (!edificio) return res.json({ mensaje: "QR inválido ❌" });

  // 2. Buscar usuario
  const [[user]] = await pool.execute(
    `SELECT u.id, u.nombre, IFNULL(r.nombre,'usuario') AS rol
     FROM usuarios u
     LEFT JOIN roles r ON u.rol_id = r.id
     WHERE u.cedula=?`,
    [cedula]
  );
  if (!user) return res.json({ mensaje: "Usuario no existe ❌" });

  // 3. Device en uso por otra cédula
  const [usados] = await pool.execute(
    "SELECT id FROM dispositivos WHERE device_id=? AND cedula<>?",
    [deviceId, cedula]
  );
  if (usados.length > 0) {
    return res.status(403).json({ mensaje: "🚫 Este celular ya pertenece a otra persona" });
  }

  // 4. Admin: registrar dispositivo automáticamente en todos los edificios
  if (user.rol === "Administración") {
    const [adminDevs] = await pool.execute(
      "SELECT * FROM dispositivos WHERE cedula=?", [cedula]
    );
    if (adminDevs.length === 0) {
      const [todos] = await pool.execute("SELECT id FROM edificios");
      const values  = todos.map(e => [cedula, deviceId, e.id, 1]);
      await pool.query(
        "INSERT INTO dispositivos (cedula, device_id, edificio_id, autorizado) VALUES ?",
        [values]
      );
    } else if (!adminDevs.some(d => d.device_id === deviceId)) {
      return res.status(403).json({ mensaje: "🚫 Este celular no corresponde a este administrador" });
    }
    return registrarMovimiento(user, edificio, cedula, res);
  }

  // 5. Cédula en otro dispositivo (protección anti-suplantación)
  const [otrosDevs] = await pool.execute(
    "SELECT id FROM dispositivos WHERE cedula=? AND device_id<>?",
    [cedula, deviceId]
  );
  if (otrosDevs.length > 0) {
    return res.status(403).json({ mensaje: "🚫 Esta cédula ya está asociada a otro celular" });
  }

  // 6. ¿Esta cédula ya tiene algún dispositivo anclado/conocido en el sistema?
  //    (sin importar el edificio). Si sí, el celular ya quedó verificado como
  //    suyo y lo que falta es solo comprobar autorización para ESTE edificio.
  const [algunDispositivo] = await pool.execute(
    "SELECT id FROM dispositivos WHERE cedula=? LIMIT 1",
    [cedula]
  );
  const cedulaYaAnclada = algunDispositivo.length > 0;

  // 7. Buscar permiso para este edificio en particular
  const [devs] = await pool.execute(
    `SELECT * FROM dispositivos
     WHERE cedula=? AND edificio_id=?
     AND (device_id=? OR device_id='')
     ORDER BY CASE WHEN device_id=? THEN 0 ELSE 1 END LIMIT 1`,
    [cedula, edificio.id, deviceId, deviceId]
  );

  if (devs.length === 0) {
    if (cedulaYaAnclada) {
      // El celular ya está verificado como de esta cédula, pero no tiene
      // permiso para este edificio específico: acceso denegado directo.
      return res.status(403).json({ mensaje: "🚫 No estás autorizado para ingresar a este edificio" });
    }
    // Primera vez que esta cédula usa el sistema: se ancla el dispositivo
    // como pendiente de aprobación por un administrador.
    await pool.execute(
      "INSERT INTO dispositivos (cedula, device_id, edificio_id, autorizado) VALUES (?,?,?,0)",
      [cedula, deviceId, edificio.id]
    );
    return res.status(403).json({ mensaje: "⏳ Dispositivo pendiente de aprobación" });
  }

  const dispositivo = devs[0];
  if (dispositivo.autorizado != 1) {
    return res.status(403).json({ mensaje: "🚫 Dispositivo no autorizado aún" });
  }

  if (!dispositivo.device_id) {
    await pool.execute(
      "UPDATE dispositivos SET device_id=? WHERE id=?",
      [deviceId, dispositivo.id]
    );
  }

  return registrarMovimiento(user, edificio, cedula, res);
}));

// ─────────────────────────────────────────
// HELPER REGISTRAR MOVIMIENTO (async)
// ─────────────────────────────────────────
async function registrarMovimiento(user, edificio, cedula, res) {
  const [last] = await pool.execute(
    "SELECT * FROM registros WHERE cedula=? AND edificio_id=? ORDER BY fecha_hora DESC LIMIT 1",
    [cedula, edificio.id]
  );

  if (last.length > 0) {
    const diffMin = (Date.now() - new Date(last[0].fecha_hora)) / 60_000;
    if (diffMin < 60) {
      const min = Math.ceil(60 - diffMin);
      const tipo = last[0].tipo_registro;
      const msg  = tipo === "Entrada"
        ? `⚠️ Ya tienes una Entrada registrada. Salida disponible en ${min} min.`
        : `⚠️ Ya tienes una Salida registrada. Próxima Entrada en ${min} min.`;
      return res.status(429).json({ mensaje: msg });
    }
  }

  // Si la última Entrada fue en un día distinto al de hoy (ciclo sin salida),
  // reiniciar el ciclo para que hoy registre una nueva Entrada.
  let tipo;
  if (last.length > 0 && last[0].tipo_registro === "Entrada") {
    const fechaUltimo = new Date(last[0].fecha_hora);
    const hoy = new Date();
    const mismodia =
      fechaUltimo.getFullYear() === hoy.getFullYear() &&
      fechaUltimo.getMonth()    === hoy.getMonth()    &&
      fechaUltimo.getDate()     === hoy.getDate();
    tipo = mismodia ? "Salida" : "Entrada";
  } else {
    tipo = "Entrada";
  }

  await pool.execute(
    "INSERT INTO registros (nombre, cedula, edificio, tipo_registro, edificio_id, rol) VALUES (?,?,?,?,?,?)",
    [user.nombre, cedula, edificio.nombre, tipo, edificio.id, user.rol]
  );

  await auditLog("registro_qr", { cedula, edificio: edificio.nombre, tipo }, cedula);

  res.json({ mensaje: `${tipo} registrada ✅`, edificio: edificio.nombre, tipo });
}

// ─────────────────────────────────────────
// EXPORTAR EXCEL — MEJORA: autenticación correcta
// (Bearer token en header, no window.location)
// ─────────────────────────────────────────
app.get("/admin/exportar-excel", validarAdmin, asyncHandler(async (req, res) => {
  const conditions = ["1=1"];
  const params     = [];

  if (req.query.edificio_id) {
    const eid = parseInt(req.query.edificio_id, 10);
    if (!isNaN(eid)) { conditions.push("edificio_id=?"); params.push(eid); }
  }
  if (req.query.cedula) {
    const ced = req.query.cedula.replace(/\D/g, "");
    if (ced) { conditions.push("cedula=?"); params.push(ced); }
  }
  if (req.query.fecha_desde) {
    conditions.push("fecha_hora >= ?");
    params.push(req.query.fecha_desde + " 00:00:00");
  }
  if (req.query.fecha_hasta) {
    conditions.push("fecha_hora <= ?");
    params.push(req.query.fecha_hasta + " 23:59:59");
  }

  const [rows] = await pool.execute(
    `SELECT * FROM registros WHERE ${conditions.join(" AND ")} ORDER BY fecha_hora DESC`,
    params
  );

  const wb    = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Registros");

  sheet.columns = [
    { header: "ID",          key: "id",            width: 8  },
    { header: "Nombre",      key: "nombre",         width: 28 },
    { header: "Cédula",      key: "cedula",         width: 18 },
    { header: "Edificio",    key: "edificio",       width: 24 },
    { header: "Rol",         key: "rol",            width: 16 },
    { header: "Tipo",        key: "tipo_registro",  width: 12 },
    { header: "Fecha (UTC)", key: "fecha_hora",     width: 22 },
    { header: "Observación", key: "observacion",    width: 28 },
  ];

  // Estilos header
  sheet.getRow(1).eachCell(cell => {
    cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F7A63" } };
    cell.font   = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.border = { bottom: { style: "thin" } };
  });

  rows.forEach(r => {
    const row = sheet.addRow(r);
    if (r.observacion) {
      row.getCell("observacion").font = { color: { argb: "FFCC0000" }, bold: true };
    }
    if (r.tipo_registro === "Entrada") {
      row.getCell("tipo_registro").font = { color: { argb: "FF1F7A63" }, bold: true };
    } else {
      row.getCell("tipo_registro").font = { color: { argb: "FF0F3D2E" } };
    }
  });

  await auditLog("exportar_excel", { filtros: req.query });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="registros-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

// ─────────────────────────────────────────
// CRON — MEJORA #5: node-cron cada hora en punto
// MEJORA: lógica corregida (entrada sin salida posterior)
// ─────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    const [entradas] = await pool.execute(`
      SELECT id, cedula, edificio_id, fecha_hora FROM registros
      WHERE tipo_registro = 'Entrada'
        AND TIMESTAMPDIFF(HOUR, fecha_hora, UTC_TIMESTAMP()) > 12
        AND (observacion IS NULL OR observacion = '')
    `);

    for (const entrada of entradas) {
      const [salidas] = await pool.execute(`
        SELECT id FROM registros
        WHERE cedula=? AND edificio_id=? AND tipo_registro='Salida'
          AND fecha_hora > ?
        LIMIT 1
      `, [entrada.cedula, entrada.edificio_id, entrada.fecha_hora]);

      if (salidas.length === 0) {
        await pool.execute(
          "UPDATE registros SET observacion='🚨 Salida no registrada' WHERE id=?",
          [entrada.id]
        );
      }
    }
    if (entradas.length) console.log(`⏰ Cron: ${entradas.length} alertas procesadas`);
  } catch (err) {
    console.error("❌ Error cron:", err.message);
  }
});

// ─────────────────────────────────────────
// MIDDLEWARE DE ERRORES GLOBAL — MEJORA #7
// ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("❌ Error no manejado:", err.message, err.stack);
  res.status(500).json({ mensaje: "Error interno del servidor" });
});

// ─────────────────────────────────────────
// AUDIT LOG TABLE (crear si no existe)
// ─────────────────────────────────────────
async function initDB() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id      INT AUTO_INCREMENT PRIMARY KEY,
        accion  VARCHAR(80) NOT NULL,
        detalle TEXT,
        cedula  VARCHAR(30),
        fecha   DATETIME NOT NULL
      )
    `);
    console.log("✅ Tabla audit_log lista");
  } catch (err) {
    console.error("⚠️ No se pudo crear audit_log:", err.message);
  }
}

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
});
