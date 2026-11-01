# UiXtream License Server

## Windows executable

1. Keep `UiXtreamLicenseServer.exe` and `.env` in the same folder.
2. Copy the existing `.env` from the server folder, or create one using `.env.example`.
3. Set the Supabase URL/service key and the `OWNER_*` / `ADMIN_*` account values in `.env`. `ADMIN_USERNAMES` accepts comma-separated admin usernames.
4. Run the executable. It starts the server and opens `http://localhost:8000` in the browser.

The `.exe` bundles the Node runtime and panel files. `.env` stays outside the executable so Supabase credentials and login passwords are not embedded in it. The generated `ACCESO_PANEL.txt` contains the local account passwords and should be kept private.

To rebuild the Windows executable, run `npm install` and then `npm run build:exe` from this folder. Node.js is only needed for development and rebuilding, not to run the executable.

## Standalone seller executable (Supabase Edge Function)

The standalone seller build uses only the public Supabase key. It does not include the service-role key. Authorization and database changes run inside `supabase/functions/panel-api`.

One-time cloud setup from the project owner PC:

1. Use Node.js 20 or later, open PowerShell, and change to this folder.
2. Run `npm install --save-dev supabase`, then `npx supabase login`.
3. Link the project with `npx supabase link --project-ref yqomkgcbzvdhuxzpyqry` and enter the project's database password if prompted.
4. Run `powershell -ExecutionPolicy Bypass -File .\deploy-supabase.ps1`. It applies the account/session tables, uploads Owner/Admin credentials from the ignored `.env` as Supabase secrets, and deploys the API. The temporary secrets file is removed automatically.
5. Rebuild with `npm run build:exe`. Distribute only `UiXtreamLicenseServer.exe`; do not distribute `.env` or `supabase_config.json`.

The cloud function enforces permissions server-side: Seller creates keys, Admin creates and blocks/unblocks keys, and Owner has full management rights. Initial Owner/Admin accounts are read from `.env` during deployment. Additional accounts created in the panel are stored in Supabase, so they work from another PC.

## Roles

- **Owner:** unrestricted key durations, including lifetime, and all license/device management actions.
- **Admin:** create keys (up to 15 weeks) and block/unblock license keys. Cannot delete keys, change HWIDs, reset activations, or ban devices.
- **Seller:** create keys up to 15 weeks; cannot block keys or manage devices.
- The Owner can create or remove additional Admin and Seller accounts in the panel. Passwords for additional accounts are stored as salted scrypt hashes in the local data folder.

The server enforces role permissions on every administrative API request. Sessions expire after eight hours of inactivity.
