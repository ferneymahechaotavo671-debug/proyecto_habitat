const express = require("express");
require("dotenv").config();
const mysql = require("mysql2");
const path = require("path");

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
    res.json(data);
  });
});

// =========================
// REGISTROS (FALTABA)
// =========================
app.get("/admin/registros", validarAdmin, (req, res) => {
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

  db.query(sql, params, (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

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

    const edificio = eds.find(e =>
      normalizar(e.codigo_qr) === codigoEdificio
    );

    if (!edificio) return res.json({ mensaje: "QR inválido ❌" });

    db.query(
      `SELECT u.id, u.nombre, r.nombre AS rol
       FROM usuarios u
       JOIN roles r ON u.rol_id = r.id
       WHERE u.cedula=?`,
      [cedula],
      (err, users) => {

        if (err) return res.status(500).json({ mensaje: "Error usuario" });
        if (users.length === 0) return res.json({ mensaje: "Usuario no existe ❌" });

        const user = users[0];

        db.query(
          "SELECT * FROM dispositivos WHERE cedula=? AND edificio_id=?",
          [cedula, edificio.id],
          (err, devs) => {

            if (err) return res.status(500).json({ mensaje: "Error dispositivos" });

            if (devs.length > 0) {
              if (devs[0].device_id !== deviceId && user.rol !== "admin") {
                return res.status(403).json({ mensaje: "Dispositivo no autorizado 🚫" });
              }
            }

            if (devs.length === 0) {
              db.query(
                "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?, ?, ?)",
                [cedula, deviceId, edificio.id]
              );
            }

            db.query(
              `SELECT * FROM registros 
               WHERE cedula=? AND edificio_id=? 
               ORDER BY fecha_hora DESC LIMIT 1`,
              [cedula, edificio.id],
              (err, last) => {

                let tipo = "Entrada";

                if (last.length > 0) {
                  tipo = last[0].tipo_registro === "Entrada" ? "Salida" : "Entrada";
                }

                db.query(
                  `INSERT INTO registros 
                  (nombre, cedula, edificio, tipo_registro, edificio_id, rol)
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
  });
});

// =========================
// CREAR USUARIO
// =========================
app.post("/admin/crear-usuario", validarAdmin, (req, res) => {

  const { nombre, cedula, rol_id } = req.body;

  db.query(
    "INSERT INTO usuarios (nombre, cedula, rol_id) VALUES (?,?,?)",
    [nombre, cedula, rol_id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ ok: true });
    }
  );
});

// =========================
// ASIGNAR PERMISO
// =========================
app.post("/admin/asignar-edificio", validarAdmin, (req, res) => {

  const { cedula, edificio_id } = req.body;

  db.query(
    "INSERT INTO dispositivos (cedula, device_id, edificio_id) VALUES (?, '', ?)",
    [cedula, edificio_id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ ok: true });
    }
  );
});

// =========================
// QUITAR PERMISO
// =========================
app.post("/admin/quitar-permiso", validarAdmin, (req, res) => {

  const { cedula, edificio_id } = req.body;

  db.query(
    "DELETE FROM dispositivos WHERE cedula=? AND edificio_id=?",
    [cedula, edificio_id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ ok: true });
    }
  );
});

// =========================
// AGREGAR EDIFICIO
// =========================
app.post("/admin/agregar-edificio", validarAdmin, (req, res) => {

  const nombre = req.body.nombre;
  const codigo_qr = normalizar(nombre);

  db.query(
    "INSERT INTO edificios (nombre, codigo_qr) VALUES (?,?)",
    [nombre, codigo_qr],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ ok: true });
    }
  );
});

// =========================
// SERVER
// =========================
app.listen(PORT, () => {
  console.log("Servidor corriendo en", PORT);
});