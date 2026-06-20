# Habitat Seguridad v2.0

Sistema de control de acceso por código QR para personal de aseo.

---

## Cambios v2.0 (mejoras aplicadas)

### 🔴 Críticos (seguridad)
- **Password solo en servidor**: eliminado del HTML del cliente. La validación ocurre únicamente en el backend vía `Authorization` header.
- **Pool MySQL**: reemplazado `createConnection` por `createPool` con reconexión automática y manejo de concurrencia.
- **Sin SQL injection**: todos los parámetros de consulta usan `?` parametrizado, incluyendo los filtros de `/admin/registros` y `/admin/exportar-excel`.
- **.env protegido**: el archivo `.env` está correctamente en `.gitignore`. Las credenciales reales nunca deben subirse al repo.

### 🟠 Robustez
- **node-cron**: el cron de alertas ahora corre cada hora en punto (`0 * * * *`) en vez de `setInterval`.
- **async/await lineal**: reescrito `/registro` y todos los endpoints, eliminando callback hell.
- **Error handler global**: middleware de Express que captura cualquier error no manejado y responde 500.
- **UTC timezone**: pool configurado con `timezone: "+00:00"` para consistencia entre regiones.

### 🟡 Funcionales
- **Paginación**: `/admin/registros` acepta `limit` y `offset`. El cliente muestra controles de página.
- **Bloqueo persistente**: el bloqueo de 5 min en el cliente usa `localStorage` y sobrevive recargas.
- **Exportar Excel con auth**: usa `fetch()` + blob en vez de `window.location`, enviando el header `Authorization`.
- **Audit log**: tabla `audit_log` creada automáticamente. Registra: registro QR, aprobación de dispositivos, exportaciones, creación de usuarios/edificios.
- **Modales funcionales**: los modales de dispositivos y permisos ahora tienen botones y funciones conectadas.

### 🟢 Detalles
- `manifest.json`: tamaños de iconos corregidos (192×192 y 512×512).
- `style.css` externo: eliminado (estilos integrados en cada HTML).
- Service Worker mejorado: cache-first para estáticos, network-first para API.
- `alert()` nativo reemplazado por Toast y `confirm()` solo donde es crítico.

---

## Estructura de archivos

```
PROYECTO HABITAT/
├── server.js              # Backend principal (Express + MySQL pool)
├── package.json
├── .env                   # ← NO subir al repo (ver .gitignore)
├── .env.example           # ← Plantilla de variables de entorno
├── .gitignore
└── publico/
    ├── index.html         # App empleados (escáner QR, móvil-first)
    ├── admin.html         # Panel administrativo
    ├── manifest.json      # PWA manifest (corregido)
    ├── sw.js              # Service Worker (cache strategy)
    ├── logo.png
    ├── icon-192.png
    └── icon-512.png
```

---

## Variables de entorno (.env)

Copia `.env.example` a `.env` y completa los valores:

```bash
cp .env.example .env
```

| Variable         | Descripción                          |
|------------------|--------------------------------------|
| `MYSQLHOST`      | Host de Railway MySQL                |
| `MYSQLPORT`      | Puerto (Railway usa ≈27885)          |
| `MYSQLUSER`      | Usuario MySQL                        |
| `MYSQLPASSWORD`  | Contraseña MySQL                     |
| `MYSQLDATABASE`  | Nombre de la base de datos           |
| `ADMIN_PASSWORD` | Contraseña del panel admin (solo servidor) |
| `PORT`           | Puerto del servidor (Railway lo asigna automáticamente) |

---

## Migración de base de datos

Al iniciar el servidor por primera vez v2.0, se crea automáticamente:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  accion  VARCHAR(80) NOT NULL,
  detalle TEXT,
  cedula  VARCHAR(30),
  fecha   DATETIME NOT NULL
);
```

No se modifica ninguna tabla existente.

---

## Despliegue en Railway

1. Sube los archivos al repositorio (sin `.env`).
2. En Railway → Variables de entorno, agrega todas las variables del `.env.example`.
3. En especial, cambia `ADMIN_PASSWORD` por una contraseña segura.
4. Railway detecta `package.json` y corre `npm start` automáticamente.

---

## Seguridad — puntos pendientes (próxima versión)

- [ ] Reemplazar password simple por JWT con expiración
- [ ] Rate limiting en `/registro` y `/login` (librería `express-rate-limit`)
- [ ] HTTPS forzado (Railway lo maneja, pero verificar redirección)
- [ ] Sanitizar `device_id` para evitar valores arbitrariamente largos
