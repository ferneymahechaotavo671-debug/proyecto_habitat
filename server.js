const express = require("express");
const mysql = require("mysql2");
const path = require("path");
const ExcelJS = require("exceljs");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "publico")));

// 🔍 Verificar variables Railway
console.log("MYSQLHOST:", process.env.MYSQLHOST ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLUSER:", process.env.MYSQLUSER ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLPASSWORD:", process.env.MYSQLPASSWORD ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE ? "CARGADA ✅" : "NO CARGADA ❌");
console.log("MYSQLPORT:", process.env.MYSQLPORT ? "CARGADA ✅" : "NO CARGADA ❌");

// 🔌 Conexión MySQL
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

  // 🏢 TABLA EDIFICIOS
  const sqlEdificios = `
    CREATE TABLE IF NOT EXISTS edificios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100),
      codigo_qr VARCHAR(100) UNIQUE
    )
  `;

  // 👤 TABLA USUARIOS
  const sqlUsuarios = `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100),
      cedula VARCHAR(50),
      edificio_id INT
    )
  `;

  // 📊 TABLA REGISTROS (ADAPTADA)
  const sqlRegistros = `
    CREATE TABLE IF NOT EXISTS registros (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100),
      cedula VARCHAR(50),
      edificio VARCHAR(100),
      tipo_registro VARCHAR(20),
      fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
      edificio_id INT
    )
  `;

  db.query(sqlEdificios);
  db.query(sqlUsuarios);
  db.query(sqlRegistros);

  console.log("✅ Tablas listas");
});

// 🌐 RUTA PRINCIPAL
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "publico", "index.html"));
});

// 🧪 TEST
app.get("/test", (req, res) => {
  res.send("Servidor funcionando correctamente 🚀");
});

// 🔥 REGISTRO CON QR AUTOMÁTICO
app.post("/registro", (req, res) => {
  const { cedula, codigoEdificio } = req.body;

  if (!cedula || !codigoEdificio) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }

  // 1. Buscar edificio por QR
  db.query(
    "SELECT * FROM edificios WHERE codigo_qr = ?",
    [codigoEdificio],
    (err, edificios) => {
      if (err) return res.status(500).json({ mensaje: "Error servidor" });

      if (edificios.length === 0) {
        return res.json({ mensaje: "QR inválido ❌" });
      }

      const edificio = edificios[0];

      // 2. Validar usuario
      db.query(
  "SELECT * FROM registros WHERE cedula = ? AND edificio_id = ? ORDER BY fecha_hora DESC LIMIT 1",
  [cedula, edificio.id],
        (err, usuarios) => {
          if (usuarios.length === 0) {
            return res.json({ mensaje: "No autorizado 🚫" });
          }

          const usuario = usuarios[0];

          // 3. Revisar último registro
          db.query(
            "SELECT * FROM registros WHERE cedula = ? ORDER BY fecha_hora DESC LIMIT 1",
            [cedula],
            (err, registros) => {

              let tipo = "Entrada";

              if (registros.length > 0 && registros[0].tipo_registro === "Entrada") {
                tipo = "Salida";
              }

              // 4. Guardar registro
              db.query(
                `INSERT INTO registros 
                (nombre, cedula, edificio, tipo_registro, edificio_id) 
                VALUES (?, ?, ?, ?, ?)`,
                [usuario.nombre, cedula, edificio.nombre, tipo, edificio.id],
                (err) => {
                  if (err) {
                    console.error(err);
                    return res.status(500).json({ mensaje: "Error al registrar" });
                  }

                  res.json({ mensaje: `${tipo} registrada ✅` });
                }
              );
            }
          );
        }
      );
    }
  );
});

// 📊 ADMIN REGISTROS (CON FILTROS)
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

  sql += " ORDER BY r.fecha_hora DESC";

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ mensaje: "Error al obtener registros" });
    }

    res.json(results);
  });
});


// 🏢 LISTAR EDIFICIOS
app.get("/admin/edificios", (req, res) => {
  db.query("SELECT * FROM edificios", (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ mensaje: "Error al obtener edificios" });
    }
    res.json(results);
  });
});

// 📄 EXPORTAR EXCEL
app.get("/admin/exportar-excel-mensual", (req, res) => {
  const mes = req.query.mes;

  if (!mes) {
    return res.status(400).send("Mes requerido");
  }

  const sql = `
    SELECT * FROM registros 
    WHERE MONTH(fecha_hora) = ?
    ORDER BY id DESC
  `;

  db.query(sql, [mes], async (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error");
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Reporte");

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
      `attachment; filename=reporte_mes_${mes}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  });
});

// ⏰ CIERRE AUTOMÁTICO 11:59 PM
cron.schedule("59 23 * * *", () => {
  console.log("⏰ Ejecutando cierre automático...");

  db.query(`
    SELECT * FROM registros r1
    WHERE tipo_registro = 'Entrada'
    AND NOT EXISTS (
      SELECT 1 FROM registros r2
      WHERE r2.cedula = r1.cedula
      AND r2.edificio_id = r1.edificio_id
      AND r2.tipo_registro = 'Salida'
      AND r2.fecha_hora > r1.fecha_hora
    )
  `, (err, resultados) => {

    if (err) return console.error(err);

    resultados.forEach(r => {
      db.query(`
        INSERT INTO registros 
        (nombre, cedula, edificio, tipo_registro, edificio_id, observacion)
        VALUES (?, ?, ?, 'Salida', ?, 'Salida automática - No registró salida')
      `, [r.nombre, r.cedula, r.edificio, r.edificio_id]);
    });

    console.log("✅ Cierre automático completado");
  });
});

// 🚀 INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});