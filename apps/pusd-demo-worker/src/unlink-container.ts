import { Container } from '@cloudflare/containers'

import type { Env } from './context'

export class UnlinkContainer extends Container {
	defaultPort = 3000
	sleepAfter = '10m'

	constructor(ctx: any, env: Cloudflare.Env) {
		super(ctx, env)
		const typedEnv = env as Env
		this.envVars = {
			UNLINK_INTERNAL_AUTH_TOKEN: typedEnv.UNLINK_INTERNAL_AUTH_TOKEN?.trim() ?? '',
			UNLINK_DEPOSITOR_PRIVATE_KEY: typedEnv.UNLINK_DEPOSITOR_PRIVATE_KEY?.trim() ?? '',
			PUSD_TOKEN_ADDRESS: typedEnv.PUSD_TOKEN_ADDRESS?.trim() ?? '',
			PUSD_TOKEN_DECIMALS: typedEnv.PUSD_TOKEN_DECIMALS?.trim() ?? '',
			MONAD_RPC_URL: typedEnv.MONAD_RPC_URL?.trim() ?? 'https://testnet-rpc.monad.xyz',
		}
	}
}
