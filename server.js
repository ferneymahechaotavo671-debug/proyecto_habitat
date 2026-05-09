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
  if (err) return console.error("Error DB:", err);
  console.log("✅ MySQL conectado");
});

// =========================
// LOGIN
// =========================
app.post("/login", (req, res) => {
  const { password } = req.body;

  if (password === PASSWORD_ADMIN) {
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false });
});

// =========================
// REGISTRO QR (CORREGIDO SIN ROMPER FRONT)
// =========================
app.post("/registro", (req, res) => {

  let cedula = req.body.cedula?.toString().trim();

  let codigoEdificio = req.body.codigoEdificio
    ?.toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]/g, "");

  let deviceId = req.body.deviceId;
  let userAgent = req.body.userAgent;
  let observacion = req.body.observacion || "";

  if (!cedula || !codigoEdificio || !deviceId) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  // =========================
  // EDIFICIO
  // =========================
  db.query(
    "SELECT * FROM edificios WHERE codigo_qr = ?",
    [codigoEdificio],
    (err, eds) => {

      if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });
      if (eds.length === 0) return res.json({ mensaje: "QR inválido ❌" });

      const edificio = eds[0];

      // =========================
      // USUARIO + ROLES + PERMISOS
      // =========================
      db.query(
        `SELECT 
          u.id,
          u.nombre,
          u.cedula,
          r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON u.rol_id = r.id
         JOIN usuario_edificio ue ON ue.usuario_id = u.id
         WHERE u.cedula = ?
         AND ue.edificio_id = ?`,
        [cedula, edificio.id],
        (err, users) => {

          if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });
          if (users.length === 0) return res.json({ mensaje: "No autorizado 🚫" });

          const user = users[0];

          // =========================
          // DISPOSITIVO
          // =========================
          db.query(
            "SELECT * FROM dispositivos WHERE cedula=? AND edificio_id=?",
            [cedula, edificio.id],
            (err, devices) => {

              if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

              if (devices.length > 0) {

                const savedDevice = devices[0].device_id;

                // 🔥 FIX IMPORTANTE
                if (savedDevice !== deviceId && user.rol !== "admin") {
                  console.log("🚨 SUPLANTACIÓN:", cedula);

                  return res.status(403).json({
                    mensaje: "🚫 Dispositivo no autorizado"
                  });
                }
              }

              if (devices.length === 0) {
                db.query(
                  "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?, ?, ?)",
                  [cedula, deviceId, edificio.id]
                );
              }

              // =========================
              // REGISTRO ENTRADA/SALIDA
              // =========================
              db.query(
                `SELECT * FROM registros
                 WHERE cedula=? AND edificio_id=?
                 ORDER BY fecha_hora DESC
                 LIMIT 1`,
                [cedula, edificio.id],
                (err, last) => {

                  if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

                  let tipo = "Entrada";

                  if (last.length > 0) {
                    tipo = last[0].tipo_registro === "Entrada" ? "Salida" : "Entrada";
                  }

                  db.query(
                    `INSERT INTO registros
                    (nombre, cedula, edificio, tipo_registro, edificio_id, rol, observacion)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                      user.nombre,
                      cedula,
                      edificio.nombre,
                      tipo,
                      edificio.id,
                      user.rol,
                      observacion
                    ],
                    (err) => {

                      if (err) return res.status(500).json({ mensaje: "Error registro ❌" });

                      return res.json({
                        mensaje: `${tipo} registrada ✅`,
                        seguridad: "OK"
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
// ADMIN REGISTROS
// =========================
app.get("/admin/registros", validarAdmin, (req, res) => {

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

  sql += " ORDER BY r.fecha_hora DESC";

  db.query(sql, params, (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

// =========================
// EDIFICIOS
// =========================
app.get("/admin/edificios", validarAdmin, (req, res) => {
  db.query("SELECT * FROM edificios", (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

// =========================
// AGREGAR EDIFICIO
// =========================
app.post("/admin/agregar-edificio", validarAdmin, (req, res) => {

  const { nombre } = req.body;

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
      if (err) return res.status(500).json({ mensaje: "Error ❌" });
      res.json({ mensaje: "Edificio agregado ✅" });
    }
  );
});

// =========================
// CREAR USUARIO (NO TOCADO)
// =========================
app.post("/admin/crear-usuario", validarAdmin, (req, res) => {

  let { nombre, cedula, rol_id, edificios } = req.body;

  if (!Array.isArray(edificios)) {
    edificios = edificios ? [edificios] : [];
  }

  db.query(
    "SELECT id FROM usuarios WHERE cedula = ?",
    [cedula],
    (err, rows) => {

      let usuarioId;

      const asignar = () => {

        if (edificios.length === 0) {

          db.query("SELECT id FROM edificios", (err, eds) => {

            const values = eds.map(e => [usuarioId, e.id]);

            db.query(
              "INSERT INTO usuario_edificio (usuario_id, edificio_id) VALUES ?",
              [values],
              () => res.json({ mensaje: "Usuario creado con todos los edificios ✅" })
            );
          });

        } else {

          const values = edificios.map(id => [usuarioId, id]);

          db.query(
            "INSERT INTO usuario_edificio (usuario_id, edificio_id) VALUES ?",
            [values],
            () => res.json({ mensaje: "Usuario creado correctamente ✅" })
          );
        }
      };

      if (rows.length > 0) {
        usuarioId = rows[0].id;
        return asignar();
      }

      db.query(
        "INSERT INTO usuarios (nombre, cedula, rol_id) VALUES (?, ?, ?)",
        [nombre, cedula, rol_id],
        (err, result) => {
          usuarioId = result.insertId;
          asignar();
        }
      );
    }
  );
});

// =========================
// EXCEL
// =========================
app.get("/admin/exportar-excel-mensual", validarAdmin, (req, res) => {

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
        { header: "Observación", key: "observacion" },
        { header: "Fecha", key: "fecha_hora" }
      ];

      data.forEach(r => ws.addRow(r));

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader("Content-Disposition", "attachment; filename=reporte.xlsx");

      await wb.xlsx.write(res);
      res.end();
    }
  );
});

// =========================
// SERVER
// =========================
app.listen(PORT, () => {
  console.log("Servidor corriendo en", PORT);
});