const express = require("express");
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs"); // ✅ NUEVO

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "publico")));

console.log("MYSQLHOST:", process.env.MYSQLHOST ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLUSER:", process.env.MYSQLUSER ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLPASSWORD:", process.env.MYSQLPASSWORD ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLPORT:", process.env.MYSQLPORT ? "CARGADA ✅" : "NO CARGADA ❌");

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
    return;
  }

  console.log("✅ Conectado a MySQL correctamente");

  const sqlCrearTabla = `
    CREATE TABLE IF NOT EXISTS registros (
      id INT NOT NULL AUTO_INCREMENT,
      nombre VARCHAR(100) NOT NULL,
      cedula VARCHAR(50) NOT NULL,
      edificio VARCHAR(100) NOT NULL,
      tipo_registro VARCHAR(20) NOT NULL,
      fecha_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `;

  db.query(sqlCrearTabla, (err) => {
    if (err) {
      console.error("❌ Error creando tabla:", err);
    } else {
      console.log("✅ Tabla 'registros' lista");
    }
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "publico", "index.html"));
});

app.get("/test", (req, res) => {
  res.send("Servidor funcionando correctamente 🚀");
});

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

app.get("/admin/registros", (req, res) => {
  db.query("SELECT * FROM registros ORDER BY fecha_hora DESC", (err, results) => {
    if (err) {
      console.error("❌ Error obteniendo registros:", err);
      return res.status(500).json({ mensaje: "Error al obtener registros" });
    }

    res.json(results);
  });
});


// ✅ NUEVA RUTA PARA EXPORTAR EXCEL
app.get("/admin/exportar-excel", (req, res) => {
  const sql = "SELECT * FROM registros ORDER BY fecha_hora DESC";

  db.query(sql, async (err, results) => {
    if (err) {
      console.error("❌ Error generando Excel:", err);
      return res.status(500).send("Error al generar Excel");
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Registros");

    sheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Nombre", key: "nombre", width: 25 },
      { header: "Cédula", key: "cedula", width: 20 },
      { header: "Edificio", key: "edificio", width: 20 },
      { header: "Tipo", key: "tipo_registro", width: 15 },
      { header: "Fecha", key: "fecha_hora", width: 25 }
    ];

    results.forEach(r => {
      sheet.addRow({
        ...r,
        fecha_hora: new Date(r.fecha_hora).toLocaleString("es-CO", {
          timeZone: "America/Bogota"
        })
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=registros.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  });
});


app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});