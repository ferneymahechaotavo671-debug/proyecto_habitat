const express = require("express");
const mysql = require("mysql2");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Revisar si Railway sí está pasando la variable
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "CARGADA ✅" : "NO CARGADA ❌");

let db;

try {
  const dbUrl = new URL(process.env.DATABASE_URL);

  console.log("HOST detectado:", dbUrl.hostname);
  console.log("PUERTO detectado:", dbUrl.port);
  console.log("DB detectada:", dbUrl.pathname.replace("/", ""));
  console.log("USER detectado:", dbUrl.username);

  db = mysql.createConnection({
    host: dbUrl.hostname,
    user: dbUrl.username,
    password: dbUrl.password,
    database: dbUrl.pathname.replace("/", ""),
    port: dbUrl.port || 3306
  });

} catch (error) {
  console.error("❌ Error leyendo DATABASE_URL:", error);
}

// Conectar a MySQL
if (db) {
  db.connect((err) => {
    if (err) {
      console.error("❌ Error conectando a MySQL:", err);
      return;
    }

    console.log("✅ Conectado a MySQL correctamente");
  });
}

// Ruta principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Ruta de prueba
app.get("/test", (req, res) => {
  res.send("Servidor funcionando correctamente 🚀");
});

// Guardar registro
app.post("/registro", (req, res) => {
  const { nombre, cedula, edificio, tipo_registro } = req.body;

  if (!nombre || !cedula || !edificio || !tipo_registro) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const sql = `
    INSERT INTO registros (nombre, cedula, edificio, tipo_registro)
    VALUES (?, ?, ?, ?)
  `;

  db.query(sql, [nombre, cedula, edificio, tipo_registro], (err) => {
    if (err) {
      console.error("❌ Error guardando registro:", err);
      return res.status(500).json({ mensaje: "Error al guardar el registro" });
    }

    res.json({ mensaje: "✅ Registro guardado correctamente" });
  });
});

// Ver registros
app.get("/admin/registros", (req, res) => {
  db.query("SELECT * FROM registros ORDER BY fecha_hora DESC", (err, results) => {
    if (err) {
      console.error("❌ Error obteniendo registros:", err);
      return res.status(500).json({ mensaje: "Error al obtener registros" });
    }

    res.json(results);
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});