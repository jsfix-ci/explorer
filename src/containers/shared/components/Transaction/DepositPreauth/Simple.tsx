import React from 'react'
import { useTranslation } from 'react-i18next'
import { SimpleRow } from '../SimpleRow'
import { TransactionSimpleProps } from '../types'
import { DepositPreauthInstructions } from './types'

export const Simple = ({
  data,
}: TransactionSimpleProps<DepositPreauthInstructions>) => {
  const { t } = useTranslation()
  const { authorize, unauthorize } = data.instructions

  return authorize ? (
    <SimpleRow label={t('authorize')}>{authorize}</SimpleRow>
  ) : (
    <SimpleRow label={t('unauthorize')}>{unauthorize}</SimpleRow>
  )
}
