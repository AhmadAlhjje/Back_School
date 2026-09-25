# Dashboard sites (served by the edge Nginx)

- `owner/` ← content of `institute_dashboard/dist` (after `npm run build` with VITE_API_BASE_URL=https://<API_DOMAIN>)
- `admin/` ← content of `super_admin_web/dist`

Copy the files (not the dist folder itself); no restart is needed.
