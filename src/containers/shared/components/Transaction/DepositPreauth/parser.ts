import { DepositPreauth, DepositPreauthInstructions } from './types'

export const parser = (tx: DepositPreauth): DepositPreauthInstructions => ({
  authorize: tx.Authorize,
  unauthorize: tx.Unauthorize,
})
