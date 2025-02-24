import { unix } from 'moment'
import { Error, XRP_BASE, EPOCH_OFFSET } from './utils'

const N_UNL_INDEX =
  '2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244'

const formatEscrow = (d) => ({
  id: d.index,
  account: d.Account,
  destination: d.Destination,
  amount: d.Amount / XRP_BASE,
  condition: d.Condition,
  cancelAfter: d.CancelAfter
    ? unix(d.CancelAfter + EPOCH_OFFSET)
        .utc()
        .format()
    : undefined,
  finishAfter: d.FinishAfter
    ? unix(d.FinishAfter + EPOCH_OFFSET)
        .utc()
        .format()
    : undefined,
})

const formatPaychannel = (d) => ({
  id: d.index,
  account: d.Account,
  destination: d.Destination,
  amount: d.Amount / XRP_BASE,
  balance: d.Balance / XRP_BASE,
  settleDelay: d.SettleDelay,
})

const executeQuery = async (rippledSocket, params) =>
  rippledSocket.send(params).catch((error) => {
    const message =
      error.response && error.response.error_message
        ? error.response.error_message
        : error.toString()
    const code =
      error.response && error.response.status ? error.response.status : 500
    throw new Error(`URL: ${rippledSocket.endpoint} - ${message}`, code)
  })

// generic RPC query
function query(rippledSocket, options) {
  return executeQuery(rippledSocket, options)
}

// If there is a separate peer to peer (not reporting mode) server for admin requests, use it.
// Otherwise use the default rippledSocket for everything.
function queryP2P(rippledSocket, options) {
  return executeQuery(rippledSocket.p2pSocket ?? rippledSocket, options)
}

// get ledger
const getLedger = (rippledSocket, parameters) => {
  const request = {
    command: 'ledger',
    ...parameters,
    transactions: true,
    expand: true,
  }

  return query(rippledSocket, request).then((resp) => {
    if (resp.error_message === 'ledgerNotFound') {
      throw new Error('ledger not found', 404)
    }

    if (resp.error_message === 'ledgerIndexMalformed') {
      throw new Error('invalid ledger index/hash', 400)
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }

    if (!resp.validated) {
      throw new Error('ledger not validated', 404)
    }
    return resp.ledger
  })
}

// get transaction
const getTransaction = (rippledSocket, txHash) => {
  const params = {
    command: 'tx',
    transaction: txHash,
  }

  return query(rippledSocket, params).then((resp) => {
    if (resp.error === 'txnNotFound') {
      throw new Error('transaction not found', 404)
    }

    if (resp.error === 'notImpl') {
      throw new Error('invalid transaction hash', 400)
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }

    if (!resp.validated) {
      throw new Error('transaction not validated', 500)
    }
    return resp
  })
}

// get account info
const getAccountInfo = (rippledSocket, account) =>
  query(rippledSocket, {
    command: 'account_info',
    account,
    ledger_index: 'validated',
    signer_lists: true,
  }).then((resp) => {
    if (resp.error === 'actNotFound') {
      throw new Error('account not found', 404)
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }

    return Object.assign(resp.account_data, {
      ledger_index: resp.ledger_index,
    })
  })

// get account escrows
const getAccountEscrows = (
  rippledSocket,
  account,
  ledger_index = 'validated',
) =>
  query(rippledSocket, {
    command: 'account_objects',
    account,
    ledger_index,
    type: 'escrow',
    limit: 400,
  }).then((resp) => {
    if (resp.error === 'actNotFound') {
      throw new Error('account not found', 404)
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }

    if (!resp.account_objects.length) {
      return undefined
    }

    const escrows = { in: [], out: [], total: 0, totalIn: 0, totalOut: 0 }
    resp.account_objects.forEach((d) => {
      const amount = Number(d.Amount)
      escrows.total += amount
      if (account === d.Destination) {
        escrows.in.push(formatEscrow(d))
        escrows.totalIn += amount
      } else {
        escrows.out.push(formatEscrow(d))
        escrows.totalOut += amount
      }
    })

    escrows.total /= XRP_BASE
    escrows.totalIn /= XRP_BASE
    escrows.totalOut /= XRP_BASE
    return escrows
  })

// get account paychannels
const getAccountPaychannels = async (
  rippledSocket,
  account,
  ledger_index = 'validated',
) => {
  const list = []
  let remaining = 0
  const getChannels = (marker) =>
    query(rippledSocket, {
      command: 'account_objects',
      marker,
      account,
      ledger_index,
      type: 'payment_channel',
      limit: 400,
    }).then((resp) => {
      if (resp.error === 'actNotFound') {
        throw new Error('account not found', 404)
      }

      if (resp.error_message) {
        throw new Error(resp.error_message, 500)
      }

      if (!resp.account_objects.length) {
        return undefined
      }

      list.push(...resp.account_objects)
      if (resp.marker) {
        return getChannels(resp.marker)
      }

      return null
    })

  await getChannels()
  const channels = list.map((c) => {
    remaining += c.Amount - c.Balance
    return formatPaychannel(c)
  })
  return channels.length
    ? {
        channels,
        total_available: remaining / XRP_BASE,
      }
    : null
}

// get Token balance summary
const getBalances = (rippledSocket, account, ledger_index = 'validated') =>
  queryP2P(rippledSocket, {
    command: 'gateway_balances',
    account,
    ledger_index,
  }).then((resp) => {
    if (resp.error === 'actNotFound') {
      throw new Error('account not found', 404)
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }

    return resp
  })

// get account transactions
const getAccountTransactions = (
  rippledSocket,
  account,
  limit = 20,
  marker = '',
) => {
  const markerComponents = marker.split('.')
  const ledger = parseInt(markerComponents[0], 10)
  const seq = parseInt(markerComponents[1], 10)
  return query(rippledSocket, {
    command: 'account_tx',
    account,
    limit,
    ledger_index_max: -1,
    ledger_index_min: -1,
    marker: marker
      ? {
          ledger,
          seq,
        }
      : undefined,
  }).then((resp) => {
    if (resp.error === 'actNotFound') {
      throw new Error('account not found', 404)
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }
    return {
      transactions: resp.transactions,
      marker: resp.marker
        ? `${resp.marker.ledger}.${resp.marker.seq}`
        : undefined,
    }
  })
}

const getAccountNFTs = (rippledSocket, account, marker = '', limit = 20) =>
  query(rippledSocket, {
    command: 'account_nfts',
    account,
    marker: marker || undefined,
    limit,
  })

const getNFTInfo = (rippledSocket, tokenId) =>
  queryP2P(rippledSocket, {
    command: 'nft_info',
    nft_id: tokenId,
  }).then((resp) => {
    if (resp.error === 'objectNotFound') {
      throw new Error('NFT not found', 404)
    }
    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }
    return resp
  })

const getNFToffers = (
  offerCmd,
  rippledSocket,
  tokenId,
  limit = 50,
  marker = '',
) =>
  query(rippledSocket, {
    command: offerCmd,
    nft_id: tokenId,
    limit,
    marker: marker !== '' ? marker : undefined,
  }).then((resp) => {
    if (resp.error === 'objectNotFound') {
      throw new Error('NFT not found', 404)
    }
    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }
    return resp
  })

const getBuyNFToffers = (rippledSocket, tokenId, limit = 50, marker = '') =>
  getNFToffers('nft_buy_offers', rippledSocket, tokenId, limit, marker)

const getSellNFToffers = (rippledSocket, tokenId, limit = 50, marker = '') =>
  getNFToffers('nft_sell_offers', rippledSocket, tokenId, limit, marker)

const getNFTTransactions = (
  rippledSocket,
  tokenId,
  limit = 20,
  marker = '',
  forward = false,
) => {
  const markerComponents = marker.split('.')
  const ledger = parseInt(markerComponents[0], 10)
  const seq = parseInt(markerComponents[1], 10)
  return queryP2P(rippledSocket, {
    command: 'nft_history',
    nft_id: tokenId,
    limit,
    ledger_index_max: -1,
    ledger_index_min: -1,
    marker: marker
      ? {
          ledger,
          seq,
        }
      : undefined,
    forward,
  }).then((resp) => {
    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }
    return {
      transactions: resp.transactions,
      marker: resp.marker
        ? `${resp.marker.ledger}.${resp.marker.seq}`
        : undefined,
    }
  })
}

const getNegativeUNL = (rippledSocket) =>
  query(rippledSocket, {
    command: 'ledger_entry',
    index: N_UNL_INDEX,
  }).then((resp) => {
    if (
      resp.error === 'entryNotFound' ||
      resp.error === 'lgrNotFound' ||
      resp.error === 'objectNotFound'
    ) {
      return []
    }

    if (resp.error_message) {
      throw new Error(resp.error_message, 500)
    }

    return resp
  })

const getServerInfo = (rippledSocket) =>
  query(rippledSocket, {
    command: 'server_info',
  }).then((resp) => {
    if (resp.error !== undefined || resp.error_message !== undefined) {
      throw new Error(resp.error_message || resp.error, 500)
    }

    return resp
  })

const getOffers = (
  rippledSocket,
  currencyCode,
  issuerAddress,
  pairCurrencyCode,
  pairIssuerAddress,
) =>
  query(rippledSocket, {
    command: 'book_offers',
    taker_gets: {
      currency: `${currencyCode.toUpperCase()}`,
      issuer:
        currencyCode.toUpperCase() === 'XRP' ? undefined : `${issuerAddress}`,
    },
    taker_pays: {
      currency: `${pairCurrencyCode.toUpperCase()}`,
      issuer:
        pairCurrencyCode.toUpperCase() === 'XRP'
          ? undefined
          : `${pairIssuerAddress}`,
    },
  }).then((resp) => {
    if (resp.error !== undefined || resp.error_message !== undefined) {
      throw new Error(resp.error_message || resp.error, 500)
    }

    return resp
  })
export {
  getLedger,
  getTransaction,
  getAccountInfo,
  getAccountEscrows,
  getAccountPaychannels,
  getAccountNFTs,
  getBalances,
  getAccountTransactions,
  getNegativeUNL,
  getServerInfo,
  getOffers,
  getNFTInfo,
  getBuyNFToffers,
  getSellNFToffers,
  getNFTTransactions,
}
