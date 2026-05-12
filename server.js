const express = require("express");
require("dotenv").config();
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 8080;

const PASSWORD_ADMIN = "Habitat2026";

// =========================
// MIDDLEWARE
// =========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "publico")));

// =========================
// AUTH ADMIN
// =========================
function validarAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== PASSWORD_ADMIN) {
    return res.status(403).json({ mensaje: "Acceso denegado 🔒" });
  }
  next();
}

// =========================
// MYSQL
// =========================
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

// =========================
// NORMALIZAR
// =========================
function normalizar(t) {
  return (t || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// =========================
// LOGIN ADMIN
// =========================
app.post("/login", (req, res) => {
  if (req.body.password === PASSWORD_ADMIN) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

// =========================
// EDIFICIOS
// =========================
app.get("/admin/edificios", (req, res) => {
  db.query("SELECT * FROM edificios", (err, data) => {
    if (err) return res.status(500).json(err);

    // ORDENADOS
    data.sort((a, b) => a.nombre.localeCompare(b.nombre));

    res.json(data);
  });
});

app.get("/admin/dispositivos", validarAdmin, (req,res)=>{

db.query(`
SELECT 
d.id,
u.nombre,
d.cedula,
d.device_id,
d.autorizado,
e.nombre AS edificio
FROM dispositivos d
LEFT JOIN usuarios u ON d.cedula=u.cedula
LEFT JOIN edificios e ON d.edificio_id=e.id
ORDER BY d.id DESC
`, (err,data)=>{

if(err) return res.status(500).json(err);

res.json(data);

});

});

app.post("/admin/aprobar-dispositivo", validarAdmin, (req,res)=>{

db.query(
"UPDATE dispositivos SET autorizado=1 WHERE id=?",
[req.body.id],
(err)=>{

if(err) return res.status(500).json(err);

res.json({ok:true});

});

});

app.post("/admin/bloquear-dispositivo", validarAdmin, (req,res)=>{

db.query(
"UPDATE dispositivos SET autorizado=0 WHERE id=?",
[req.body.id],
(err)=>{

if(err) return res.status(500).json(err);

res.json({ok:true});

});

});

// =========================
// REGISTROS + OBSERVACIÓN 12H (MEJORADO)
// =========================
app.get("/admin/registros", validarAdmin, (req, res) => {

  let sql = `
  SELECT *
  FROM registros
  WHERE 1=1
  `;

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

  db.query(sql, params, (err, data) => {

    if (err) {
      return res.status(500).json(err);
    }

    const ahora = new Date();

    const procesado = data.map((r, index) => {

      let obs = "";

      // SOLO VALIDAR ENTRADAS
      if (r.tipo_registro === "Entrada") {

        const entrada = new Date(r.fecha_hora);

        const diffHoras =
          (ahora - entrada) / (1000 * 60 * 60);

        // BUSCAR SI EXISTE SALIDA DESPUÉS
        const tieneSalida = data.some(s => {

          return (
            s.cedula === r.cedula &&
            s.edificio_id === r.edificio_id &&
            s.tipo_registro === "Salida" &&
            new Date(s.fecha_hora) > entrada
          );

        });

        // SOLO ALERTA SI NO TIENE SALIDA
        if (diffHoras > 12 && !tieneSalida) {

          obs = "🚨 Salida no registrada";

        }

      }

      return {
        ...r,
        observacion: obs
      };

    });

    res.json(procesado);

  });

});

// =========================
// AUTO OBSERVACIÓN EN BD (CRON)
// =========================
setInterval(() => {

  const sql = `
    UPDATE registros r1
    LEFT JOIN registros r2 
      ON r1.cedula = r2.cedula 
      AND r1.edificio_id = r2.edificio_id
      AND r2.id > r1.id
      AND r2.tipo_registro = 'Salida'
    SET r1.observacion = '🚨 Salida no registrada'
    WHERE r1.tipo_registro = 'Entrada'
      AND r2.id IS NULL
      AND TIMESTAMPDIFF(HOUR, r1.fecha_hora, NOW()) > 12
  `;

  db.query(sql, (err) => {
    if (err) console.log("Error auto obs:", err.message);
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
    return res.status(400).json({
      mensaje: "Datos incompletos ❌"
    });
  }

  db.query("SELECT * FROM edificios", (err, eds) => {

    if (err) {
      return res.status(500).json({
        mensaje: "Error DB"
      });
    }

    const edificio = eds.find(e =>
      normalizar(e.codigo_qr) === codigoEdificio
    );

    if (!edificio) {
      return res.json({
        mensaje: "QR inválido ❌"
      });
    }

    // =========================
    // VALIDAR USUARIO
    // =========================
    db.query(
      `SELECT u.id,
              u.nombre,
              IFNULL(r.nombre,'usuario') AS rol
       FROM usuarios u
       LEFT JOIN roles r
       ON u.rol_id = r.id
       WHERE u.cedula=?`,
      [cedula],
      (err, users) => {

        if (err) {
          return res.status(500).json({
            mensaje: "Error usuario"
          });
        }

        if (users.length === 0) {
          return res.json({
            mensaje: "Usuario no existe ❌"
          });
        }

        const user = users[0];

// =========================
// VALIDAR DISPOSITIVO
// =========================
function validarDispositivo(){

db.query(
  `SELECT * FROM dispositivos
   WHERE cedula=?
   AND edificio_id=?
   AND device_id=?`,
  [cedula, edificio.id, deviceId],
  (err, devs) => {

    if (err) {
      return res.status(500).json({
        mensaje: "Error dispositivos"
      });
    }

    // =========================
    // VALIDAR SI EL DEVICE YA
    // ESTÁ ASOCIADO A OTRA CÉDULA
    // =========================
    db.query(
      `SELECT * FROM dispositivos
       WHERE device_id=?
       AND cedula<>?`,
      [deviceId, cedula],
      (err, usados) => {

        if (usados.length > 0) {

          return res.status(403).json({
            mensaje: "🚫 Este celular ya pertenece a otra persona"
          });

        }

        // =========================
        // NO EXISTE → CREAR PENDIENTE
        // =========================
        if (devs.length === 0) {

          db.query(
            `INSERT INTO dispositivos
            (cedula, device_id, edificio_id, autorizado)
            VALUES (?, ?, ?, 0)`,
            [cedula, deviceId, edificio.id]
          );

          return res.status(403).json({
            mensaje: "⏳ Dispositivo pendiente de aprobación"
          });

        }

        // =========================
        // VALIDAR AUTORIZACIÓN
        // =========================
        const dispositivo = devs[0];

        if (
          dispositivo.autorizado != 1 &&
          user.rol !== "admin"
        ) {

          return res.status(403).json({
            mensaje: "🚫 Dispositivo no autorizado"
          });

        }

        // =========================
        // ÚLTIMO REGISTRO
        // =========================
        db.query(
          `SELECT * FROM registros
           WHERE cedula=?
           AND edificio_id=?
           ORDER BY fecha_hora DESC
           LIMIT 1`,
          [cedula, edificio.id],
          (err, last) => {

            let tipo = "Entrada";

            if(last.length > 0){

              tipo =
              last[0].tipo_registro === "Entrada"
              ? "Salida"
              : "Entrada";

            }

            db.query(
              `INSERT INTO registros
              (nombre, cedula, edificio,
              tipo_registro, edificio_id, rol)
              VALUES (?,?,?,?,?,?)`,
              [
                user.nombre,
                cedula,
                edificio.nombre,
                tipo,
                edificio.id,
                user.rol
              ],
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
    );

  }
);

}

// =========================
// ADMINISTRACIÓN = ACCESO TOTAL
// =========================
if(user.rol_id == 1){

validarDispositivo();

}else{

// =========================
// VALIDAR USUARIO_EDIFICIO
// =========================
db.query(
`SELECT * FROM usuario_edificio
WHERE usuario_id=? AND edificio_id=?`,
[user.id, edificio.id],
(err, permisos)=>{

if(err){

return res.status(500).json({
mensaje:"Error permisos"
});

}

if(permisos.length === 0){

return res.status(403).json({
mensaje:"🚫 No tienes acceso a este edificio"
});

}

// SI TIENE PERMISO
validarDispositivo();

});

}

    // =========================
    // VALIDAR SI EL DEVICE YA
    // ESTÁ ASOCIADO A OTRA CÉDULA
    // =========================
    db.query(
      `SELECT * FROM dispositivos
       WHERE device_id=?
       AND cedula<>?`,
      [deviceId, cedula],
      (err, usados) => {

        if (usados.length > 0) {

          return res.status(403).json({
            mensaje: "🚫 Este celular ya pertenece a otra persona"
          });

        }

        // =========================
        // NO EXISTE → CREAR PENDIENTE
        // =========================
        if (devs.length === 0) {

          db.query(
            `INSERT INTO dispositivos
            (cedula, device_id, edificio_id, autorizado)
            VALUES (?, ?, ?, 0)`,
            [cedula, deviceId, edificio.id]
          );

          return res.status(403).json({
            mensaje: "⏳ Dispositivo pendiente de aprobación"
          });

        }

        // =========================
        // VALIDAR AUTORIZACIÓN
        // =========================
        const dispositivo = devs[0];

        if (
          dispositivo.autorizado != 1 &&
          user.rol !== "admin"
        ) {

          return res.status(403).json({
            mensaje: "🚫 Dispositivo no autorizado"
          });

        }

        // =========================
        // VALIDAR DEVICE
        // =========================
        if(dispositivo.device_id !== deviceId){

          return res.status(403).json({
            mensaje:"🚫 Este celular no está autorizado"
          });

        }

        // =========================
        // ÚLTIMO REGISTRO
        // =========================
        db.query(
          `SELECT * FROM registros
           WHERE cedula=?
           AND edificio_id=?
           ORDER BY fecha_hora DESC
           LIMIT 1`,
          [cedula, edificio.id],
          (err, last) => {

            let tipo = "Entrada";

            if(last.length > 0){

              tipo =
              last[0].tipo_registro === "Entrada"
              ? "Salida"
              : "Entrada";

            }

            db.query(
              `INSERT INTO registros
              (nombre, cedula, edificio,
              tipo_registro, edificio_id, rol)
              VALUES (?,?,?,?,?,?)`,
              [
                user.nombre,
                cedula,
                edificio.nombre,
                tipo,
                edificio.id,
                user.rol
              ],
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
    );

  }
);

      }
    );

  });

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

app.get("/admin/exportar-excel", validarAdmin, (req, res) => {

let sql = "SELECT * FROM registros WHERE 1=1";
const params = [];

if(req.query.edificio_id){
sql += " AND edificio_id=?";
params.push(req.query.edificio_id);
}

if(req.query.cedula){
sql += " AND cedula=?";
params.push(req.query.cedula);
}

sql += " ORDER BY fecha_hora DESC";

db.query(sql, params, async (err, rows) => {

if(err) return res.status(500).json(err);

const workbook = new ExcelJS.Workbook();

const sheet = workbook.addWorksheet("Registros");

sheet.columns = [
{ header:"ID", key:"id", width:10 },
{ header:"Nombre", key:"nombre", width:30 },
{ header:"Cédula", key:"cedula", width:20 },
{ header:"Edificio", key:"edificio", width:25 },
{ header:"Rol", key:"rol", width:15 },
{ header:"Tipo", key:"tipo_registro", width:15 },
{ header:"Fecha", key:"fecha_hora", width:25 }
];

rows.forEach(r=>{
sheet.addRow(r);
});

res.setHeader(
"Content-Type",
"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
);

res.setHeader(
"Content-Disposition",
"attachment; filename=registros.xlsx"
);

await workbook.xlsx.write(res);

res.end();

});

});

// =========================
// SERVER
// =========================
app.listen(PORT, () => console.log("Servidor corriendo en", PORT));