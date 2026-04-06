const express = require("express");
const mysql = require("mysql2");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, "public")));

// Logs para verificar variables de Railway
console.log("PRUEBA:", process.env.PRUEBA);
console.log("MYSQLHOST:", process.env.MYSQLHOST);
console.log("MYSQLUSER:", process.env.MYSQLUSER);
console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE);
console.log("MYSQLPORT:", process.env.MYSQLPORT);

// Conexión a MySQL
const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: Number(process.env.MYSQLPORT)
});

// Conectar a MySQL
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

// Ruta de prueba
app.get("/test", (req, res) => {
  res.send("Servidor funcionando correctamente 🚀");
});

// Crear tabla si no existe
db.query(`
  CREATE TABLE IF NOT EXISTS registros (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    apartamento VARCHAR(50) NOT NULL,
    placa VARCHAR(20) NOT NULL,
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) {
    console.error("❌ Error creando tabla:", err);
  } else {
    console.log("✅ Tabla 'registros' lista");
  }
});

// Guardar registro
app.post("/guardar", (req, res) => {
  const { nombre, apartamento, placa } = req.body;

  if (!nombre || !apartamento || !placa) {
    return res.status(400).json({ error: "Todos los campos son obligatorios" });
  }

  const sql = "INSERT INTO registros (nombre, apartamento, placa) VALUES (?, ?, ?)";
  db.query(sql, [nombre, apartamento, placa], (err, result) => {
    if (err) {
      console.error("❌ Error guardando registro:", err);
      return res.status(500).json({ error: "Error al guardar el registro" });
    }

    res.json({ mensaje: "✅ Registro guardado correctamente" });
  });
});

// Ver registros
app.get("/registros", (req, res) => {
  db.query("SELECT * FROM registros ORDER BY fecha DESC", (err, results) => {
    if (err) {
      console.error("❌ Error obteniendo registros:", err);
      return res.status(500).json({ error: "Error al obtener registros" });
    }

    res.json(results);
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});