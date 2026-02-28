import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersProject({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
				miniflare: {
					bindings: {
						ENVIRONMENT: 'VITEST',
						SENTRY_RELEASE: 'vitest',
						DEMO_ADMIN_TOKEN: 'vitest-demo-admin-token',
						COLUMN_MODE: 'mock',
						UNLINK_MODE: 'mock',
						TREASURY_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
						SHARED_PAYER_WALLET: '0x2222222222222222222222222222222222222222',
					},
					d1Databases: ['DB'],
				},
			},
		},
	},
})
