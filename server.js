const express = require("express");
require("dotenv").config();
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 8080;

const PASSWORD_ADMIN = "Habitat2026";

// =========================
// MIDDLEWARE BASE
// =========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// 🔐 MIDDLEWARE ADMIN
// =========================
function validarAdmin(req, res, next) {

  const auth = req.headers.authorization;

  if (!auth || auth !== PASSWORD_ADMIN) {
    return res.status(403).json({ mensaje: "Acceso denegado 🔒" });
  }

  next();
}

// =========================
// ARCHIVOS ESTATICOS
// =========================
app.use(express.static(path.join(__dirname, "publico")));

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
// REGISTRO QR
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

  let deviceId = req.body.deviceId; // 🔥 CORREGIDO
  let userAgent = req.body.userAgent;

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  db.query(
    `SELECT * FROM edificios WHERE codigo_qr = ?`,
    [codigoEdificio],
    (err, eds) => {

      if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

      if (eds.length === 0) {
        return res.json({ mensaje: "QR inválido ❌" });
      }

      const edificio = eds[0];

      db.query(
        `SELECT 
            u.id,
            u.nombre,
            u.cedula,
            r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON u.rol_id = r.id
         JOIN usuario_edificio ue 
            ON ue.usuario_id = u.id
         WHERE u.cedula = ?
         AND ue.edificio_id = ?`,
        [cedula, edificio.id],
        (err, users) => {

          if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

          if (users.length === 0) {
            return res.json({ mensaje: "No autorizado 🚫" });
          }

          const user = users[0];

          // =========================
          // 🔐 ANTI SUPLANTACIÓN (ARREGLADO)
          // =========================
          db.query(
            `SELECT * FROM dispositivos 
             WHERE cedula=? AND edificio_id=?`,
            [cedula, edificio.id],
            (err, devices) => {

              if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

              if (devices.length > 0) {

                const savedDevice = devices[0].device_id;

                if (savedDevice !== deviceId && user.rol !== "admin") {

                  console.log("🚨 SUPLANTACIÓN DETECTADA:", {
                    cedula,
                    deviceId,
                    savedDevice,
                    userAgent
                  });

                  return res.status(403).json({
                    mensaje: "🚫 Dispositivo no autorizado"
                  });
                }
              }

              // registrar dispositivo si no existe
              if (devices.length === 0 && deviceId) {

                db.query(
                  `INSERT INTO dispositivos (cedula, device_id, edificio_id)
                   VALUES (?, ?, ?)`,
                  [cedula, deviceId, edificio.id]
                );
              }

              // =========================
              // REGISTRO ENTRADA/SALIDA
              // =========================
              db.query(
                `SELECT *
                 FROM registros
                 WHERE cedula=? AND edificio_id=?
                 ORDER BY fecha_hora DESC
                 LIMIT 1`,
                [cedula, edificio.id],
                (err, last) => {

                  if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

                  let tipo = "Entrada";
                  let observacion = null;

                  if (last.length > 0) {

                    const ultimo = last[0];
                    const fechaUltimo = new Date(ultimo.fecha_hora);
                    const ahora = new Date();

                    const diferenciaHoras = (ahora - fechaUltimo) / (1000 * 60 * 60);

                    if (ultimo.tipo_registro === "Entrada") {

                      if (diferenciaHoras >= 12) {

                        observacion = `Salida no registrada (${Math.floor(diferenciaHoras)}h)`;

                        db.query(
                          `UPDATE registros SET observacion=? WHERE id=?`,
                          [observacion, ultimo.id]
                        );

                        tipo = "Entrada";

                      } else {
                        tipo = "Salida";
                      }
                    }
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

                      res.json({
                        mensaje: `${tipo} registrada ✅`,
                        edificio: edificio.nombre,
                        rol: user.rol,
                        observacion
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

  sql += " ORDER BY r.fecha_hora ASC, id ASC";

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

      if (err) return res.status(500).json({ mensaje: "Error edificio ❌" });

      res.json({ mensaje: "Edificio agregado ✅" });
    }
  );
});

// =========================
// SERVER
// =========================
app.listen(PORT, () => {
  console.log("Servidor corriendo en", PORT);
});