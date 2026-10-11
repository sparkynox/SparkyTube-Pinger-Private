// edit these, then keep this repo PRIVATE (the keys live in here on purpose, no .env)
module.exports = {
  // hidden panel address: https://<your-render-url>/sparky-admin-x7k2
  ADMIN_PATH: "/sparky-admin-x7k2",
  ADMIN_USER: "sparky",
  ADMIN_PASSWORD: "@HornyPass",          // the panel stays locked until you change this
  SESSION_SECRET: "gkgigigickvse58_88_88799", // any long random text

  // your Render service url, no slash at the end
  PUBLIC_URL: "https://sparkytube-api.onrender.com",

  // project "sparkytube-server" is already created and the tables exist.
  // Supabase dashboard > Project Settings > API Keys > copy the service_role (secret) key below
  SUPABASE_URL: "https://eagpejfljladgbsinnru.supabase.co",
  SUPABASE_KEY: "YOUR-SERVICE-ROLE-KEY",

  GITHUB_REPO: "sparkynox/SparkyTube"
};
