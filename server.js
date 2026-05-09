const express = require("express");
require("dotenv").config();
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 8080;

const PASSWORD_ADMIN = "Habitat2026";

// =========================
// MIDDLEWARE BASE
// =========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// 🔐 ADMIN MIDDLEWARE
// =========================
function validarAdmin(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth || auth !== PASSWORD_ADMIN) {
    return res.status(403).json({ mensaje: "Acceso denegado 🔒" });
  }

  next();
}

// =========================
// ESTATICOS
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
  if (err) console.error("Error DB:", err);
  else console.log("✅ MySQL conectado");
});

// =========================
// LOGIN ADMIN
// =========================
app.post("/login", (req, res) => {
  const { password } = req.body;

  if (password === PASSWORD_ADMIN) {
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false });
});

// =========================
// REGISTRO QR + SEGURIDAD
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

      if (eds.length === 0) {
        return res.json({ mensaje: "QR inválido ❌" });
      }

      const edificio = eds[0];

      // =========================
      // USUARIO + ROL + PERMISOS
      // =========================
      db.query(
        `
        SELECT 
          u.id,
          u.nombre,
          u.cedula,
          r.nombre AS rol
        FROM usuarios u
        JOIN roles r ON u.rol_id = r.id
        LEFT JOIN usuario_edificio ue ON ue.usuario_id = u.id
        WHERE u.cedula = ?
        AND (
          r.nombre = 'admin'
          OR r.nombre = 'servicios'
          OR r.nombre = 'todero'
          OR ue.edificio_id = ?
        )
        `,
        [cedula, edificio.id],
        (err, users) => {

          if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

          if (users.length === 0) {
            return res.json({ mensaje: "No autorizado 🚫" });
          }

          const user = users[0];

          if (!user || !user.rol) {
            return res.status(403).json({ mensaje: "Usuario inválido 🚫" });
          }

          // =========================
          // DISPOSITIVO (ANTI SUPLANTACIÓN)
          // =========================
          db.query(
            "SELECT * FROM dispositivos WHERE cedula=? AND edificio_id=?",
            [cedula, edificio.id],
            (err, devices) => {

              if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

              if (devices.length > 0) {

                const savedDevice = devices[0].device_id;

                if (savedDevice !== deviceId && user.rol !== "admin") {

                  console.log("🚨 SUPLANTACIÓN:", { cedula, deviceId, savedDevice });

                  return res.status(403).json({
                    mensaje: "🚫 Dispositivo no autorizado"
                  });
                }
              }

              // guardar dispositivo si no existe
              if (devices.length === 0) {
                db.query(
                  "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?, ?, ?)",
                  [cedula, deviceId, edificio.id]
                );
              }

              // =========================
              // REGISTRO ENTRADA / SALIDA
              // =========================
              db.query(
                `
                SELECT * FROM registros
                WHERE cedula=? AND edificio_id=?
                ORDER BY fecha_hora DESC
                LIMIT 1
                `,
                [cedula, edificio.id],
                (err, last) => {

                  if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

                  let tipo = "Entrada";

                  if (last.length > 0) {
                    tipo = last[0].tipo_registro === "Entrada" ? "Salida" : "Entrada";
                  }

                  db.query(
                    `
                    INSERT INTO registros
                    (nombre, cedula, edificio, tipo_registro, edificio_id, rol)
                    VALUES (?, ?, ?, ?, ?, ?)
                    `,
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
                        return res.status(500).json({ mensaje: "Error registro ❌" });
                      }

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
// PERMISOS
// =========================
app.post("/admin/quitar-permiso", validarAdmin, (req, res) => {

  const { cedula, edificio_id } = req.body;

  db.query(
    `
    DELETE FROM usuario_edificio 
    WHERE usuario_id = (SELECT id FROM usuarios WHERE cedula = ?)
    AND edificio_id = ?
    `,
    [cedula, edificio_id],
    (err) => {
      if (err) return res.status(500).json({ mensaje: "Error ❌" });
      res.json({ mensaje: "Permiso eliminado ✅" });
    }
  );
});

app.post("/admin/asignar-edificio", validarAdmin, (req, res) => {

  const { cedula, edificio_id } = req.body;

  db.query(
    "SELECT id FROM usuarios WHERE cedula = ?",
    [cedula],
    (err, users) => {

      if (err) return res.status(500).json({ mensaje: "Error ❌" });

      if (users.length === 0) {
        return res.status(404).json({ mensaje: "Usuario no existe ❌" });
      }

      const usuario_id = users[0].id;

      db.query(
        "INSERT IGNORE INTO usuario_edificio (usuario_id, edificio_id) VALUES (?, ?)",
        [usuario_id, edificio_id],
        (err) => {
          if (err) return res.status(500).json({ mensaje: "Error ❌" });
          res.json({ mensaje: "Permiso asignado ✅" });
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

  sql += " ORDER BY r.fecha_hora ASC";

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
// SERVER
// =========================
app.listen(PORT, () => {
  console.log("Servidor corriendo en", PORT);
});