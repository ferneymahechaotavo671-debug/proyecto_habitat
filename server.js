const express = require("express");
require("dotenv").config();
const mysql = require("mysql2");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

const PASSWORD_ADMIN = "Habitat2026";

// =========================
// MIDDLEWARE BASE
// =========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// AUTH SIMPLE ADMIN
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
  if (err) return console.error("Error DB:", err);
  console.log("✅ MySQL conectado");
});

// =========================
// NORMALIZADOR GLOBAL (IMPORTANTE)
// =========================
function normalizar(texto) {
  return (texto || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/.*[?&]edificio=/, "")
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]/g, "");
}

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
// REGISTRO
// =========================
app.post("/registro", (req, res) => {

  let cedula = req.body.cedula?.toString().trim();

  let codigoEdificio = normalizar(req.body.codigoEdificio);
  let deviceId = req.body.deviceId;

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  // =========================
  // VALIDAR EDIFICIO
  // =========================
  db.query(
    "SELECT * FROM edificios",
    (err, eds) => {

      if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

      const edificio = eds.find(e =>
        normalizar(e.codigo_qr) === codigoEdificio
      );

      if (!edificio) {
        return res.json({ mensaje: "QR inválido ❌" });
      }

      // =========================
      // VALIDAR USUARIO
      // =========================
      db.query(
        `SELECT u.id, u.nombre, r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON u.rol_id = r.id
         WHERE u.cedula = ?`,
        [cedula],
        (err, users) => {

          if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

          if (users.length === 0) {
            return res.json({ mensaje: "Usuario no existe ❌" });
          }

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

                if (savedDevice !== deviceId && user.rol !== "admin") {
                  return res.status(403).json({
                    mensaje: "🚫 Dispositivo no autorizado"
                  });
                }
              }

              if (devices.length === 0 && deviceId) {
                db.query(
                  "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?, ?, ?)",
                  [cedula, deviceId, edificio.id]
                );
              }

              // =========================
              // REGISTRO
              // =========================
              db.query(
                `SELECT * FROM registros
                 WHERE cedula=? AND edificio_id=?
                 ORDER BY fecha_hora DESC LIMIT 1`,
                [cedula, edificio.id],
                (err, last) => {

                  if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

                  let tipo = "Entrada";

                  if (last.length > 0) {
                    tipo = last[0].tipo_registro === "Entrada" ? "Salida" : "Entrada";
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

                      if (err) return res.status(500).json({ mensaje: "Error registro ❌" });

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
// EDIFICIOS (FIX VALIDACIÓN)
// =========================
app.get("/admin/edificios", (req, res) => {
  db.query("SELECT * FROM edificios", (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

// =========================
// AGREGAR EDIFICIO
// =========================
app.post("/admin/agregar-edificio", validarAdmin, (req, res) => {

  const nombre = req.body.nombre;

  const codigo_qr = normalizar(nombre);

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