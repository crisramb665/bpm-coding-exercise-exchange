// Ejemplos de respuesta para Swagger UI. Son los valores reales de un recorrido (docs/pruebas_manuales.md): 2.500 USDT-SBX,
// MEDIUM, ejecutada. Los ids y fechas son de muestra.
const USER_ID = 'user-001';
const EXCHANGE_ID = '0b1b3efa-3993-4f61-942b-ed4adfa91660';
const QUOTE_ID = 'c6a4e4c5-2b9d-4f2e-9a1d-5d9f0f3a7b21';

export const QUOTE_EXAMPLE = {
  id: QUOTE_ID,
  source_asset: 'USDT-SBX',
  target_asset: 'XAUT-SBX',
  source_amount: '2500.00000000',
  price: '2500.00000000',
  fee_rate: '0.010000',
  fee_amount: '25.00000000',
  net_amount: '2475.00000000',
  target_amount: '0.99000000',
  status: 'ACTIVE',
  created_at: '2026-10-08T18:41:14.302Z',
  expires_at: '2026-10-08T18:41:44.302Z',
};

export const EXCHANGE_DETAIL_EXAMPLE = {
  id: EXCHANGE_ID,
  user_id: USER_ID,
  status: 'COMPLETED',
  risk_level: 'MEDIUM',
  requires_follow_up: true,
  failure_reason: null,
  created_at: '2026-10-08T18:41:20.100Z',
  updated_at: '2026-10-08T18:41:20.180Z',
  quote: { ...QUOTE_EXAMPLE, status: 'USED' },
  movements: [
    { id: '2', wallet_id: 'f330b721-d052-48d6-85eb-892e11e7a27b', asset: 'USDT-SBX', entry_type: 'DEBIT', balance_type: 'AVAILABLE', amount: '2500.00000000', balance_before: '9000.01000000', balance_after: '6500.01000000', status: 'CONFIRMED', created_at: '2026-10-08T18:41:20.150Z' },
    { id: '3', wallet_id: 'a213b69e-ef33-4d52-84bd-7fd6394712a4', asset: 'XAUT-SBX', entry_type: 'CREDIT', balance_type: 'AVAILABLE', amount: '0.99000000', balance_before: '0.39599604', balance_after: '1.38599604', status: 'CONFIRMED', created_at: '2026-10-08T18:41:20.150Z' },
  ],
  compliance_checks: [
    { id: '1', provider: 'MOCK', outcome: 'OK', risk_level: 'MEDIUM', request_payload: { exchangeId: EXCHANGE_ID, userId: USER_ID, sourceAsset: 'USDT-SBX', sourceAmount: '2500.00000000' }, response_payload: { riskLevel: 'MEDIUM' }, error_message: null, duration_ms: 1, created_at: '2026-10-08T18:41:20.140Z' },
  ],
  decision: null,
  events: [
    { id: '1', from_status: null, to_status: 'PROCESSING', actor_id: USER_ID, reason: null, created_at: '2026-10-08T18:41:20.100Z' },
    { id: '2', from_status: 'PROCESSING', to_status: 'COMPLETED', actor_id: null, reason: 'Riesgo MEDIUM', created_at: '2026-10-08T18:41:20.160Z' },
  ],
};

export const EXCHANGE_SUMMARY_EXAMPLE = [
  { id: EXCHANGE_ID, user_id: USER_ID, status: 'COMPLETED', risk_level: 'MEDIUM', requires_follow_up: true, source_amount: '2500.00000000', target_amount: '0.99000000', created_at: '2026-10-08T18:41:20.100Z' },
];

export const WALLETS_EXAMPLE = [
  { id: 'f330b721-d052-48d6-85eb-892e11e7a27b', asset: 'USDT-SBX', available: '6500.01000000', held: '0.00000000', total: '6500.01000000', updated_at: '2026-10-08T18:41:20.150Z' },
  { id: 'a213b69e-ef33-4d52-84bd-7fd6394712a4', asset: 'XAUT-SBX', available: '1.38599604', held: '0.00000000', total: '1.38599604', updated_at: '2026-10-08T18:41:20.150Z' },
];

export const MOVEMENTS_EXAMPLE = [
  { id: '2', entry_type: 'DEBIT', balance_type: 'AVAILABLE', amount: '2500.00000000', balance_before: '9000.01000000', balance_after: '6500.01000000', status: 'CONFIRMED', reference_type: 'EXCHANGE', exchange_id: EXCHANGE_ID, created_at: '2026-10-08T18:41:20.150Z' },
  { id: '1', entry_type: 'CREDIT', balance_type: 'AVAILABLE', amount: '10000.00000000', balance_before: '0.00000000', balance_after: '10000.00000000', status: 'CONFIRMED', reference_type: 'INITIAL_DEPOSIT', exchange_id: null, created_at: '2026-10-08T18:00:00.000Z' },
];

export const PENDING_EXAMPLE = [
  { id: EXCHANGE_ID, user_id: USER_ID, user_name: 'Usuario de prueba', source_asset: 'USDT-SBX', source_amount: '5000.01000000', target_asset: 'XAUT-SBX', target_amount: '1.98000396', price: '2500.00000000', risk_level: 'HIGH', created_at: '2026-10-08T18:41:14.429Z' },
];
