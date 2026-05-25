const express = require("express");
require("dotenv").config();
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 8080;

const PASSWORD_ADMIN = "Habitat2026";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "publico")));

function validarAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== PASSWORD_ADMIN) {
    return res.status(403).json({ mensaje: "Acceso denegado 🔒" });
  }
  next();
}

const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT
});

db.connect(err => {
  if (err) console.error("Error DB:", err);
  else console.log("✅ MySQL conectado");
});

function normalizar(t) {
  return (t || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

app.post("/login", (req, res) => {
  if (req.body.password === PASSWORD_ADMIN) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.get("/debug/rol/:cedula", (req, res) => {
  db.query(
    `SELECT u.cedula, u.nombre, u.rol_id, r.id AS rid, r.nombre AS rol_nombre
     FROM usuarios u
     LEFT JOIN roles r ON u.rol_id = r.id
     WHERE u.cedula=?`,
    [req.params.cedula],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

app.get("/admin/edificios", (req, res) => {
  db.query("SELECT * FROM edificios", (err, data) => {
    if (err) return res.status(500).json(err);
    data.sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json(data);
  });
});

app.get("/admin/dispositivos", validarAdmin, (req, res) => {
  db.query(`
    SELECT 
      d.id,
      u.nombre,
      d.cedula,
      d.device_id,
      d.autorizado,
      e.nombre AS edificio
    FROM dispositivos d
    LEFT JOIN usuarios u ON d.cedula = u.cedula
    LEFT JOIN edificios e ON d.edificio_id = e.id
    ORDER BY d.id DESC
  `, (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

app.post("/admin/aprobar-dispositivo", validarAdmin, (req, res) => {
  db.query("UPDATE dispositivos SET autorizado=1 WHERE id=?", [req.body.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ ok: true });
  });
});

app.post("/admin/bloquear-dispositivo", validarAdmin, (req, res) => {
  db.query("UPDATE dispositivos SET autorizado=0 WHERE id=?", [req.body.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ ok: true });
  });
});

app.post("/admin/agregar-dispositivo", validarAdmin, (req, res) => {
  const { cedula, device_id, edificio_ids } = req.body;

  const getEdificios = (cb) => {
    if (edificio_ids === "todos") {
      db.query("SELECT id FROM edificios", (err, rows) => {
        if (err) return res.status(500).json(err);
        cb(rows.map(r => r.id));
      });
    } else {
      const ids = Array.isArray(edificio_ids) ? edificio_ids : [edificio_ids];
      cb(ids);
    }
  };

  getEdificios((ids) => {
    if (ids.length === 0) return res.json({ ok: true });

    let pendientes = ids.length;
    let huboError = false;

    ids.forEach(edificio_id => {
      db.query(
        `SELECT id FROM dispositivos WHERE cedula=? AND edificio_id=? LIMIT 1`,
        [cedula, edificio_id],
        (err, rows) => {
          if (err) { if (!huboError) { huboError = true; res.status(500).json(err); } return; }

          const done = () => {
            pendientes--;
            if (pendientes === 0 && !huboError) res.json({ ok: true });
          };

          if (rows.length > 0) {
            db.query(
              `UPDATE dispositivos SET device_id=?, autorizado=1 WHERE id=?`,
              [device_id || "", rows[0].id],
              (err) => { if (err && !huboError) { huboError = true; res.status(500).json(err); return; } done(); }
            );
          } else {
            db.query(
              `INSERT INTO dispositivos (cedula, device_id, edificio_id, autorizado) VALUES (?,?,?,1)`,
              [cedula, device_id || "", edificio_id],
              (err) => { if (err && !huboError) { huboError = true; res.status(500).json(err); return; } done(); }
            );
          }
        }
      );
    });
  });
});

// =========================
// REGISTROS + ALERTA 12H (CORREGIDO)
// Evalúa TODOS los registros de entrada, no solo uno
// =========================
app.get("/admin/registros", validarAdmin, (req, res) => {

  let sql = `SELECT * FROM registros WHERE 1=1`;
  const params = [];

  if (req.query.edificio_id) {
    sql += " AND edificio_id=?";
    params.push(req.query.edificio_id);
  }

  if (req.query.cedula) {
    sql += " AND cedula=?";
    params.push(req.query.cedula);
  }

  sql += " ORDER BY fecha_hora ASC"; // ASC para procesar cronológicamente

  db.query(sql, params, (err, data) => {
    if (err) return res.status(500).json(err);

    const ahora = new Date();

    // Construir mapa de entradas activas (sin salida posterior)
    // clave: cedula + edificio_id → fecha de entrada más reciente sin salida
    const entradasActivas = new Map();

    data.forEach(r => {
      const clave = `${r.cedula}_${r.edificio_id}`;

      if (r.tipo_registro === "Entrada") {
        // Guardar esta entrada (puede haber varias, nos quedamos con la más reciente)
        // Como están en orden ASC, cada nueva entrada sobreescribe la anterior
        entradasActivas.set(clave, {
          id: r.id,
          fecha: new Date(r.fecha_hora)
        });
      } else if (r.tipo_registro === "Salida") {
        // Esta salida cierra la entrada activa para esta clave
        entradasActivas.delete(clave);
      }
    });

    // IDs de entradas que están activas (sin salida) y llevan +12h
    const idsEnAlerta = new Set();

    entradasActivas.forEach((entrada) => {
      const diffHoras = (ahora - entrada.fecha) / (1000 * 60 * 60);
      if (diffHoras > 12) {
        idsEnAlerta.add(entrada.id);
      }
    });

    // Mapear los registros añadiendo observacion
    // Devolver en orden DESC para que el admin vea lo más reciente primero
    const procesado = data
      .slice()
      .reverse()
      .map(r => {
        const obs = idsEnAlerta.has(r.id) ? "🚨 Salida no registrada" : "";
        return { ...r, observacion: obs };
      });

    res.json(procesado);
  });
});

// =========================
// CRON: PERSISTIR ALERTAS EN BD (CORREGIDO)
// Marca TODAS las entradas sin salida con +12h,
// no solo las que no tienen ningún registro posterior
// =========================
setInterval(() => {

  // Paso 1: obtener todas las entradas que llevan más de 12h
  db.query(`
    SELECT id, cedula, edificio_id, fecha_hora
    FROM registros
    WHERE tipo_registro = 'Entrada'
      AND TIMESTAMPDIFF(HOUR, fecha_hora, NOW()) > 12
  `, (err, entradas) => {

    if (err) { console.log("Error cron step1:", err.message); return; }
    if (entradas.length === 0) return;

    // Paso 2: para cada entrada, verificar si tiene salida posterior
    let pendientes = entradas.length;

    entradas.forEach(entrada => {

      db.query(`
        SELECT id FROM registros
        WHERE cedula = ?
          AND edificio_id = ?
          AND tipo_registro = 'Salida'
          AND fecha_hora > ?
        LIMIT 1
      `, [entrada.cedula, entrada.edificio_id, entrada.fecha_hora],
      (err, salidas) => {

        pendientes--;

        if (err) { console.log("Error cron step2:", err.message); return; }

        // Solo marcar si NO tiene salida posterior
        if (salidas.length === 0) {
          db.query(
            `UPDATE registros SET observacion = '🚨 Salida no registrada' WHERE id = ?`,
            [entrada.id],
            (err) => {
              if (err) console.log("Error cron update:", err.message);
            }
          );
        }

      });

    });

  });

}, 10 * 60 * 1000);

// =========================
// REGISTRO QR
// =========================
app.post("/registro", (req, res) => {

  const cedula = req.body.cedula?.toString().trim();
  const codigoEdificio = normalizar(req.body.codigoEdificio);
  const deviceId = req.body.deviceId;

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  db.query("SELECT * FROM edificios", (err, eds) => {
    if (err) return res.status(500).json({ mensaje: "Error DB" });

    const edificio = eds.find(e => normalizar(e.codigo_qr) === codigoEdificio);

    if (!edificio) {
      return res.json({ mensaje: "QR inválido ❌" });
    }

    db.query(
      `SELECT u.id, u.nombre, IFNULL(r.nombre,'usuario') AS rol
       FROM usuarios u
       LEFT JOIN roles r ON u.rol_id = r.id
       WHERE u.cedula=?`,
      [cedula],
      (err, users) => {
        if (err) return res.status(500).json({ mensaje: "Error usuario" });

        if (users.length === 0) {
          return res.json({ mensaje: "Usuario no existe ❌" });
        }

        const user = users[0];

        db.query(
          `SELECT * FROM dispositivos WHERE device_id=? AND cedula<>?`,
          [deviceId, cedula],
          (err, usados) => {
            if (err) return res.status(500).json({ mensaje: "Error validando dispositivo" });

            if (usados.length > 0) {
              return res.status(403).json({
                mensaje: "🚫 Este celular ya pertenece a otra persona"
              });
            }

            if (user.rol === "Administración") {

              db.query(
                `SELECT * FROM dispositivos WHERE cedula=?`,
                [cedula],
                (err, adminDevs) => {
                  if (err) return res.status(500).json({ mensaje: "Error dispositivos admin" });

                  if (adminDevs.length === 0) {

                    db.query("SELECT id FROM edificios", (err, todosEds) => {
                      if (err) return res.status(500).json({ mensaje: "Error edificios" });

                      const values = todosEds.map(e => [cedula, deviceId, e.id, 1]);

                      db.query(
                        "INSERT INTO dispositivos (cedula, device_id, edificio_id, autorizado) VALUES ?",
                        [values],
                        (err) => {
                          if (err) return res.status(500).json({ mensaje: "Error registrando admin" });
                          registrarMovimiento(user, edificio, cedula, res);
                        }
                      );
                    });

                  } else {

                    const essuyo = adminDevs.some(d => d.device_id === deviceId);

                    if (!essuyo) {
                      return res.status(403).json({
                        mensaje: "🚫 Este celular no corresponde a este administrador"
                      });
                    }

                    registrarMovimiento(user, edificio, cedula, res);
                  }
                }
              );

              return;
            }

            db.query(
              `SELECT * FROM dispositivos WHERE cedula=? AND device_id<>?`,
              [cedula, deviceId],
              (err, otrosDevices) => {
                if (err) return res.status(500).json({ mensaje: "Error validando cédula" });

                if (otrosDevices.length > 0) {
                  return res.status(403).json({
                    mensaje: "🚫 Esta cédula ya está asociada a otro celular"
                  });
                }

                db.query(
                  `SELECT * FROM dispositivos
                   WHERE cedula=? AND edificio_id=?
                   AND (device_id=? OR device_id='')
                   ORDER BY CASE WHEN device_id=? THEN 0 ELSE 1 END
                   LIMIT 1`,
                  [cedula, edificio.id, deviceId, deviceId],
                  (err, devs) => {
                    if (err) return res.status(500).json({ mensaje: "Error dispositivos" });

                    if (devs.length === 0) {
                      db.query(
                        `INSERT INTO dispositivos (cedula, device_id, edificio_id, autorizado)
                         VALUES (?, ?, ?, 0)`,
                        [cedula, deviceId, edificio.id]
                      );
                      return res.status(403).json({
                        mensaje: "⏳ Dispositivo pendiente de aprobación"
                      });
                    }

                    const dispositivo = devs[0];

                    if (dispositivo.autorizado != 1) {
                      return res.status(403).json({
                        mensaje: "🚫 Dispositivo no autorizado aún"
                      });
                    }

                    if (dispositivo.device_id === "" || dispositivo.device_id === null) {
                      db.query(
                        `UPDATE dispositivos SET device_id=? WHERE id=?`,
                        [deviceId, dispositivo.id],
                        (err) => {
                          if (err) return res.status(500).json({ mensaje: "Error actualizando device" });
                          registrarMovimiento(user, edificio, cedula, res);
                        }
                      );
                    } else {
                      registrarMovimiento(user, edificio, cedula, res);
                    }
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// =========================
// HELPER: REGISTRAR ENTRADA O SALIDA
// =========================
function registrarMovimiento(user, edificio, cedula, res) {

  db.query(
    `SELECT * FROM registros
     WHERE cedula=? AND edificio_id=?
     ORDER BY fecha_hora DESC LIMIT 1`,
    [cedula, edificio.id],
    (err, last) => {
      if (err) return res.status(500).json({ mensaje: "Error consultando registros" });

      const ahora = new Date();

      if (last && last.length > 0) {
        const ultimo = last[0];
        const fechaUltimo = new Date(ultimo.fecha_hora);
        const diffMin = (ahora - fechaUltimo) / (1000 * 60);
        const tipoUltimo = ultimo.tipo_registro;

        if (diffMin < 60) {
          const minRestantes = Math.ceil(60 - diffMin);
          let msg = "";

          if (tipoUltimo === "Entrada") {
            msg = `⚠️ Ya tienes una Entrada registrada. Podrás registrar tu Salida en ${minRestantes} minuto${minRestantes !== 1 ? "s" : ""}.`;
          } else {
            msg = `⚠️ Ya tienes una Salida registrada. Podrás registrar tu próxima Entrada en ${minRestantes} minuto${minRestantes !== 1 ? "s" : ""}.`;
          }

          return res.status(429).json({ mensaje: msg });
        }
      }

      const tipo = (last && last.length > 0 && last[0].tipo_registro === "Entrada")
        ? "Salida"
        : "Entrada";

      db.query(
        `INSERT INTO registros
         (nombre, cedula, edificio, tipo_registro, edificio_id, rol)
         VALUES (?,?,?,?,?,?)`,
        [user.nombre, cedula, edificio.nombre, tipo, edificio.id, user.rol],
        () => {
          res.json({
            mensaje: `${tipo} registrada ✅`,
            edificio: edificio.nombre
          });
        }
      );
    }
  );
}

// =========================
// CRUD USUARIOS
// =========================
app.post("/admin/crear-usuario", validarAdmin, (req, res) => {
  db.query(
    "INSERT INTO usuarios (nombre, cedula, rol_id) VALUES (?,?,?)",
    [req.body.nombre, req.body.cedula, req.body.rol_id],
    () => res.json({ ok: true })
  );
});

app.post("/admin/editar-usuario", validarAdmin, (req, res) => {
  db.query(
    "UPDATE usuarios SET nombre=?, cedula=?, rol_id=? WHERE id=?",
    [req.body.nombre, req.body.cedula, req.body.rol_id, req.body.id],
    () => res.json({ ok: true })
  );
});

// =========================
// CRUD EDIFICIOS
// =========================
app.post("/admin/agregar-edificio", validarAdmin, (req, res) => {
  db.query(
    "INSERT INTO edificios (nombre, codigo_qr) VALUES (?,?)",
    [req.body.nombre, normalizar(req.body.nombre)],
    () => res.json({ ok: true })
  );
});

app.post("/admin/editar-edificio", validarAdmin, (req, res) => {
  db.query(
    "UPDATE edificios SET nombre=?, codigo_qr=? WHERE id=?",
    [req.body.nombre, normalizar(req.body.nombre), req.body.id],
    () => res.json({ ok: true })
  );
});

// =========================
// PERMISOS
// =========================
app.post("/admin/asignar-edificio", validarAdmin, (req, res) => {
  db.query(
    "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?,?,?)",
    [req.body.cedula, "", req.body.edificio_id],
    () => res.json({ ok: true })
  );
});

app.post("/admin/quitar-permiso", validarAdmin, (req, res) => {
  db.query(
    "DELETE FROM dispositivos WHERE cedula=? AND edificio_id=?",
    [req.body.cedula, req.body.edificio_id],
    () => res.json({ ok: true })
  );
});

// =========================
// EXPORTAR EXCEL
// =========================
app.get("/admin/exportar-excel", validarAdmin, (req, res) => {

  let sql = "SELECT * FROM registros WHERE 1=1";
  const params = [];

  if (req.query.edificio_id) {
    sql += " AND edificio_id=?";
    params.push(req.query.edificio_id);
  }

  if (req.query.cedula) {
    sql += " AND cedula=?";
    params.push(req.query.cedula);
  }

  sql += " ORDER BY fecha_hora DESC";

  db.query(sql, params, async (err, rows) => {
    if (err) return res.status(500).json(err);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Registros");

    sheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Nombre", key: "nombre", width: 30 },
      { header: "Cédula", key: "cedula", width: 20 },
      { header: "Edificio", key: "edificio", width: 25 },
      { header: "Rol", key: "rol", width: 15 },
      { header: "Tipo", key: "tipo_registro", width: 15 },
      { header: "Fecha", key: "fecha_hora", width: 25 },
      { header: "Observación", key: "observacion", width: 30 }
    ];

    rows.forEach(r => { sheet.addRow(r); });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=registros.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  });
});

// =========================
// SERVER
// =========================
app.listen(PORT, () => console.log("Servidor corriendo en", PORT));