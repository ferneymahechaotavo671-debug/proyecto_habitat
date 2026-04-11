const express = require("express");
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");
const cron = require("node-cron");

// 🔥 FECHA COLOMBIA
function fechaColombia() {
  const fecha = new Date();

  const opciones = {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  };

  const partes = new Intl.DateTimeFormat("en-CA", opciones).formatToParts(fecha);

  const map = {};
  partes.forEach(p => {
    map[p.type] = p.value;
  });

  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "publico")));

// 🔌 MYSQL
const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT
});

db.connect(err => {
  if (err) return console.error("Error DB:", err);
  console.log("✅ MySQL conectado");
});

/* =========================
   🔥 REGISTRO QR
========================= */
app.post("/registro", (req, res) => {

  let cedula = req.body.cedula?.toString().trim();

  let codigoEdificio = req.body.codigoEdificio
    ?.toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]/g, "");

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  db.query(
    `SELECT * FROM edificios WHERE codigo_qr = ?`,
    [codigoEdificio],
    (err, eds) => {

      if (err) {
        console.error("ERROR EDIFICIO:", err);
        return res.status(500).json({ mensaje: "Error servidor ❌" });
      }

      if (eds.length === 0) {
        return res.json({ mensaje: "QR inválido ❌" });
      }

      const edificio = eds[0];

      db.query(
        `SELECT u.id, u.nombre, u.cedula, r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON u.rol_id = r.id
         JOIN usuario_edificio ue ON ue.usuario_id = u.id
         WHERE u.cedula = ? AND ue.edificio_id = ?`,
        [cedula, edificio.id],
        (err, users) => {

          if (err) {
            console.error("ERROR USUARIO:", err);
            return res.status(500).json({ mensaje: "Error servidor ❌" });
          }

          if (users.length === 0) {
            return res.json({ mensaje: "No autorizado 🚫" });
          }

          const user = users[0];

          db.query(
            `SELECT * FROM registros
             WHERE cedula = ? AND edificio_id = ?
             ORDER BY fecha_hora DESC LIMIT 1`,
            [cedula, edificio.id],
            (err, last) => {

              if (err) {
                console.error("ERROR HISTORIAL:", err);
                return res.status(500).json({ mensaje: "Error servidor ❌" });
              }

              let tipo = "Entrada";

              if (last.length > 0 && last[0].tipo_registro === "Entrada") {
                tipo = "Salida";
              }

              db.query(
                `INSERT INTO registros
                (nombre, cedula, edificio, tipo_registro, edificio_id, rol) 
                VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  user.nombre,
                  cedula,
                  edificio.nombre,
                  tipo,
                  edificio.id,
                  user.rol
                ],
                (err) => {

                  if (err) {
                    console.error("ERROR INSERT:", err);
                    return res.status(500).json({ mensaje: "Error registro ❌" });
                  }

                  res.json({
                    mensaje: `${tipo} registrada ✅`,
                    edificio: edificio.nombre,
                    rol: user.rol
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

/* =========================
   📊 ADMIN REGISTROS
========================= */
app.get("/admin/registros", (req, res) => {

  const { edificio_id, cedula } = req.query;

  let sql = `
    SELECT r.*, e.nombre AS edificio_nombre
    FROM registros r
    LEFT JOIN edificios e ON r.edificio_id = e.id
    WHERE 1=1
  `;

  let params = [];

  if (edificio_id) {
    sql += " AND r.edificio_id = ?";
    params.push(edificio_id);
  }

  if (cedula) {
    sql += " AND r.cedula = ?";
    params.push(cedula);
  }

  sql += " ORDER BY r.fecha_hora ASC, id ASC";

  db.query(sql, params, (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

/* =========================
   🏢 EDIFICIOS
========================= */
app.get("/admin/edificios", (req, res) => {
  db.query("SELECT * FROM edificios", (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

/* =========================
   🏢 AGREGAR EDIFICIO
========================= */
app.post("/admin/agregar-edificio", (req, res) => {

  const { nombre } = req.body;

  if (!nombre) {
    return res.status(400).json({ mensaje: "Nombre requerido" });
  }

  // 🔥 FIX: mismo formato que usa el QR del frontend
  const codigo_qr = nombre
    .toLowerCase()
    .trim()
    .replace(/\./g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");

  db.query(
    "INSERT INTO edificios (nombre, codigo_qr) VALUES (?, ?)",
    [nombre, codigo_qr],
    (err) => {

      if (err) {
        console.error(err);
        return res.status(500).json({ mensaje: "Error al guardar edificio ❌" });
      }

      res.json({ mensaje: "Edificio agregado correctamente ✅" });
    }
  );
});

/* =========================
   👤 CREAR USUARIO
========================= */
app.post("/admin/crear-usuario", (req, res) => {

  let { nombre, cedula, rol_id, edificios } = req.body;

  if (!nombre || !cedula || !rol_id) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }

  if (!Array.isArray(edificios)) {
    edificios = edificios ? [edificios] : [];
  }

  // 🔍 1. VER SI EL USUARIO YA EXISTE
  db.query(
    "SELECT id FROM usuarios WHERE cedula = ?",
    [cedula],
    (err, rows) => {

      if (err) {
        console.error(err);
        return res.status(500).json({ mensaje: "Error consultando usuario ❌" });
      }

      let usuarioId;

      const continuarAsignacion = () => {

        // 🔥 si no selecciona edificios → todos
        if (edificios.length === 0) {

          db.query("SELECT id FROM edificios", (err, eds) => {

            if (err) {
              console.error(err);
              return res.status(500).json({ mensaje: "Error edificios ❌" });
            }

            const values = eds.map(e => [usuarioId, e.id]);

            db.query(
              "INSERT INTO usuario_edificio (usuario_id, edificio_id) VALUES ?",
              [values],
              (err) => {
                if (err) {
                  console.error(err);
                  return res.status(500).json({ mensaje: "Error asignando edificios ❌" });
                }

                return res.json({ mensaje: "Usuario listo con TODOS los edificios ✅" });
              }
            );
          });

        } else {

          const values = edificios.map(id => [usuarioId, id]);

          db.query(
            "INSERT INTO usuario_edificio (usuario_id, edificio_id) VALUES ?",
            [values],
            (err) => {

              if (err) {
                console.error(err);
                return res.status(500).json({ mensaje: "Error asignando edificios ❌" });
              }

              return res.json({ mensaje: "Usuario asignado correctamente ✅" });
            }
          );
        }
      };

      // 👇 SI YA EXISTE
      if (rows.length > 0) {

        usuarioId = rows[0].id;

        return continuarAsignacion();
      }

      // 👇 SI NO EXISTE → CREAR
      db.query(
        "INSERT INTO usuarios (nombre, cedula, rol_id) VALUES (?, ?, ?)",
        [nombre, cedula, rol_id],
        (err, result) => {

          if (err) {
            console.error(err);
            return res.status(500).json({ mensaje: "Error creando usuario ❌" });
          }

          usuarioId = result.insertId;

          continuarAsignacion();
        }
      );
    }
  );
});

/* =========================
   📄 EXCEL
========================= */
app.get("/admin/exportar-excel-mensual", (req, res) => {

  const mes = req.query.mes;

  db.query(
    "SELECT * FROM registros WHERE MONTH(fecha_hora)=?",
    [mes],
    async (err, data) => {

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Reporte");

      ws.columns = [
        { header: "ID", key: "id" },
        { header: "Nombre", key: "nombre" },
        { header: "Cédula", key: "cedula" },
        { header: "Edificio", key: "edificio" },
        { header: "Tipo", key: "tipo_registro" },
        { header: "Rol", key: "rol" },
        { header: "Fecha", key: "fecha_hora" }
      ];

      data.forEach(r => {
        ws.addRow({
          ...r,
          fecha_hora: new Date(r.fecha_hora).toLocaleString("es-CO", {
            timeZone: "America/Bogota"
          })
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader("Content-Disposition", "attachment");

      await wb.xlsx.write(res);
      res.end();
    }
  );
});

/* =========================
   ⏰ CRON
========================= */
cron.schedule("59 23 * * *", () => {
  console.log("⏰ cierre automático ejecutado");
});

/* =========================
   🚀 SERVER
========================= */
app.listen(PORT, () => {
  console.log("Servidor corriendo en", PORT);
});