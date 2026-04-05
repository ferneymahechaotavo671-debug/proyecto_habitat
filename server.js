const express = require("express");
const mysql = require("mysql2");
const path = require("path");

const app = express();

// Railway usa este puerto automáticamente
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, "public")));

console.log("MYSQLHOST:", process.env.MYSQLHOST);
console.log("MYSQLUSER:", process.env.MYSQLUSER);
console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE);
console.log("MYSQLPORT:", process.env.MYSQLPORT);

// Conexión a MySQL (Railway)
const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT
});

db.connect((err) => {
  if (err) {
    console.error("❌ Error conectando a MySQL:", err);
  } else {
    console.log("✅ Conectado a MySQL");
  }
});

// Ruta principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Ruta admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Registrar entrada/salida
app.post("/registro", (req, res) => {
  const { nombre, cedula, edificio, tipo_registro } = req.body;

  if (!nombre || !cedula || !edificio || !tipo_registro) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const sql = `
    INSERT INTO registros (nombre, cedula, edificio, tipo_registro)
    VALUES (?, ?, ?, ?)
  `;

  db.query(sql, [nombre, cedula, edificio, tipo_registro], (err, result) => {
    if (err) {
      console.error("❌ Error al guardar:", err);
      return res.status(500).json({ mensaje: "Error al guardar en la base de datos" });
    }

    res.json({ mensaje: "Registro guardado correctamente" });
  });
});

// Ver todos los registros (para admin)
app.get("/registros", (req, res) => {
  const sql = "SELECT * FROM registros ORDER BY id DESC";

  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ Error al consultar registros:", err);
      return res.status(500).json({ mensaje: "Error al consultar registros" });
    }

    res.json(results);
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});