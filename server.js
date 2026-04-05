const express = require("express");
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================
// MIDDLEWARE
// ============================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ============================
// CONEXIÓN MYSQL (LOCAL O RAILWAY)
// ============================
const db = mysql.createConnection({
  host: process.env.MYSQLHOST || "localhost",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "TU_CONTRASEÑA_REAL",
  database: process.env.MYSQLDATABASE || "proyecto_habitat",
  port: process.env.MYSQLPORT || 3306
});

db.connect((err) => {
  if (err) {
    console.error("Error de conexión a MySQL:", err);
  } else {
    console.log("Conectado a MySQL correctamente");
  }
});

// ============================
// RUTA PRINCIPAL
// ============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================
// PANEL ADMIN
// ============================
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ============================
// REGISTRO DE ENTRADA / SALIDA
// ============================
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
      console.error("Error al guardar registro:", err);
      return res.status(500).json({ mensaje: "Error al guardar en la base de datos" });
    }

    res.json({ mensaje: "Registro guardado correctamente" });
  });
});

// ============================
// OBTENER REGISTROS (ADMIN)
// ============================
app.get("/admin/registros", (req, res) => {
  const { mes, anio } = req.query;

  let sql = "SELECT * FROM registros";
  let valores = [];

  if (mes && anio) {
    sql += " WHERE MONTH(fecha_hora) = ? AND YEAR(fecha_hora) = ?";
    valores = [mes, anio];
  }

  sql += " ORDER BY fecha_hora DESC";

  db.query(sql, valores, (err, results) => {
    if (err) {
      console.error("Error al obtener registros:", err);
      return res.status(500).json({ mensaje: "Error al consultar registros" });
    }

    res.json(results);
  });
});

// ============================
// INFORME MENSUAL POR TRABAJADOR
// ============================
app.get("/admin/informe-mensual", (req, res) => {
  const { mes, anio } = req.query;

  if (!mes || !anio) {
    return res.status(400).json({ mensaje: "Debes enviar mes y año" });
  }

  const sql = `
    SELECT 
      nombre,
      cedula,
      edificio,
      SUM(CASE WHEN tipo_registro = 'Entrada' THEN 1 ELSE 0 END) AS total_entradas,
      SUM(CASE WHEN tipo_registro = 'Salida' THEN 1 ELSE 0 END) AS total_salidas
    FROM registros
    WHERE MONTH(fecha_hora) = ? AND YEAR(fecha_hora) = ?
    GROUP BY nombre, cedula, edificio
    ORDER BY nombre ASC
  `;

  db.query(sql, [mes, anio], (err, results) => {
    if (err) {
      console.error("Error al generar informe mensual:", err);
      return res.status(500).json({ mensaje: "Error al generar informe" });
    }

    res.json(results);
  });
});

// ============================
// EXPORTAR A EXCEL
// ============================
app.get("/admin/exportar-excel", async (req, res) => {
  try {
    const { mes, anio } = req.query;

    if (!mes || !anio) {
      return res.status(400).send("Debes seleccionar mes y año");
    }

    const sql = `
      SELECT 
        nombre,
        cedula,
        edificio,
        SUM(CASE WHEN tipo_registro = 'Entrada' THEN 1 ELSE 0 END) AS total_entradas,
        SUM(CASE WHEN tipo_registro = 'Salida' THEN 1 ELSE 0 END) AS total_salidas
      FROM registros
      WHERE MONTH(fecha_hora) = ? AND YEAR(fecha_hora) = ?
      GROUP BY nombre, cedula, edificio
      ORDER BY nombre ASC
    `;

    db.query(sql, [mes, anio], async (err, results) => {
      if (err) {
        console.error("Error al generar Excel:", err);
        return res.status(500).send("Error al generar Excel");
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Informe Mensual");

      worksheet.columns = [
        { header: "Nombre", key: "nombre", width: 25 },
        { header: "Cédula", key: "cedula", width: 20 },
        { header: "Edificio", key: "edificio", width: 20 },
        { header: "Total Entradas", key: "total_entradas", width: 18 },
        { header: "Total Salidas", key: "total_salidas", width: 18 }
      ];

      results.forEach((fila) => worksheet.addRow(fila));

      const nombreArchivo = `informe_mensual_${anio}_${mes}.xlsx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=${nombreArchivo}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });

  } catch (error) {
    console.error("Error exportando Excel:", error);
    res.status(500).send("Error interno al exportar Excel");
  }
});

// ============================
// QR PARA REGISTRO
// ============================
app.get("/qr", async (req, res) => {
  try {
    const urlRegistro = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const qrImage = await QRCode.toDataURL(urlRegistro);

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QR Registro Habitat</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg, #0f3d2e, #1f7a63, #38b48b);
            color: white;
            text-align: center;
            padding: 40px;
          }
          .box {
            background: white;
            color: #0f3d2e;
            max-width: 450px;
            margin: auto;
            padding: 30px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          }
          img {
            width: 280px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>QR de Registro</h1>
          <p>Escanea este código para ingresar al formulario</p>
          <img src="${qrImage}" alt="Código QR">
          <p><strong>${urlRegistro}</strong></p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Error generando QR:", error);
    res.status(500).send("Error al generar el QR");
  }
});

// ============================
// INICIAR SERVIDOR
// ============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});