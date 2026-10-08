// Las pruebas usan SIEMPRE su propia base (exchange_test) para no tocar los datos de desarrollo.
// Se parte de la base del servidor de desarrollo y solo se cambia el nombre de la base.
export const ADMIN_URL = 'postgres://exchange:exchange@localhost:5433/postgres';
export const TEST_DB_NAME = 'exchange_test';
export const TEST_DATABASE_URL = `postgres://exchange:exchange@localhost:5433/${TEST_DB_NAME}`;

// Nunca se respeta un DATABASE_URL heredado del entorno: así es imposible correr las pruebas contra otra base.
process.env.DATABASE_URL = TEST_DATABASE_URL;
