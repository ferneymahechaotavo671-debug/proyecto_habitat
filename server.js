const express = require("express");
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
// 🔐 LOGIN ADMIN
// =========================
app.post("/login", (req, res) => {
  const { password } = req.body;

  if (password === PASSWORD_ADMIN) {
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false });
});

// =========================
// 🔐 PROTECCIÓN ADMIN (IMPORTANTE)
// =========================
app.use((req, res, next) => {

  if (req.path === "/admin.html") {
    return next();
  }

  if (req.path.startsWith("/admin/")) {

    const auth = req.headers.authorization;

    if (!auth || auth !== PASSWORD_ADMIN) {
      return res.status(403).send("Acceso denegado 🔒");
    }
  }

  next();
});

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

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos ❌" });
  }

  db.query(
    `SELECT * FROM edificios WHERE codigo_qr = ?`,
    [codigoEdificio],
    (err, eds) => {

      if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });
      if (eds.length === 0) return res.json({ mensaje: "QR inválido ❌" });

      const edificio = eds[0];

      db.query(
        `SELECT u.id, u.nombre, u.cedula, r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON u.rol_id = r.id
         JOIN usuario_edificio ue ON ue.usuario_id = u.id
         WHERE u.cedula = ? AND ue.edificio_id = ?`,
        [cedula, edificio.id],
        (err, users) => {

          if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });
          if (users.length === 0) return res.json({ mensaje: "No autorizado 🚫" });

          const user = users[0];

          db.query(
            `SELECT * FROM registros
             WHERE cedula = ? AND edificio_id = ?
             ORDER BY fecha_hora DESC LIMIT 1`,
            [cedula, edificio.id],
            (err, last) => {

              if (err) return res.status(500).json({ mensaje: "Error servidor ❌" });

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
                    console.error(err);
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

// =========================
// ADMIN REGISTROS
// =========================
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
// AGREGAR EDIFICIO
// =========================
app.post("/admin/agregar-edificio", (req, res) => {

  const { nombre } = req.body;

  if (!nombre) {
    return res.status(400).json({ mensaje: "Nombre requerido" });
  }

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
// CREAR USUARIO
// =========================
app.post("/admin/crear-usuario", (req, res) => {

  let { nombre, cedula, rol_id, edificios } = req.body;

  if (!nombre || !cedula || !rol_id) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }

  if (!Array.isArray(edificios)) {
    edificios = edificios ? [edificios] : [];
  }

  db.query(
    "SELECT id FROM usuarios WHERE cedula = ?",
    [cedula],
    (err, rows) => {

      if (err) return res.status(500).json({ mensaje: "Error usuario ❌" });

      let usuarioId;

      const asignar = () => {

        if (edificios.length === 0) {

          db.query("SELECT id FROM edificios", (err, eds) => {

            if (err) return res.status(500).json({ mensaje: "Error edificios ❌" });

            const values = eds.map(e => [usuarioId, e.id]);

            db.query(
              "INSERT INTO usuario_edificio (usuario_id, edificio_id) VALUES ?",
              [values],
              (err) => {
                if (err) return res.status(500).json({ mensaje: "Error asignación ❌" });

                return res.json({ mensaje: "Usuario creado con todos los edificios ✅" });
              }
            );
          });

        } else {

          const values = edificios.map(id => [usuarioId, id]);

          db.query(
            "INSERT INTO usuario_edificio (usuario_id, edificio_id) VALUES ?",
            [values],
            (err) => {

              if (err) return res.status(500).json({ mensaje: "Error asignación ❌" });

              return res.json({ mensaje: "Usuario creado correctamente ✅" });
            }
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

          if (err) return res.status(500).json({ mensaje: "Error creando usuario ❌" });

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

      data.forEach(r => ws.addRow(r));

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader("Content-Disposition", "attachment");

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