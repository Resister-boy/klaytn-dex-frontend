import { acceptHMRUpdate, defineStore } from 'pinia'
import { Status } from '@soramitsu-ui/ui'
import invariant from 'tiny-invariant'
import { useTask, useStaleIfErrorState, wheneverTaskErrors, wheneverTaskSucceeds } from '@vue-kakuyaku/core'
import { Address, Wei, WeiAsToken } from '@/core/kaikas'
import BigNumber from 'bignumber.js'
import { TokenType, TokensPair, buildPair, mirrorTokenType } from '@/utils/pair'
import Debug from 'debug'
import { useGetAmount, GetAmountProps } from '../composable.get-amount'
import { usePairAddress } from '../../ModuleTradeShared/composable.pair-by-tokens'
import { useSwapValidation } from '../composable.validation'
import { buildSwapProps, TokenAddrAndWeiInput } from '../util.swap-props'
import { useTokensInput } from '../../ModuleTradeShared/composable.tokens-input'

const debugModule = Debug('swap-store')

export const useSwapStore = defineStore('swap', () => {
  const kaikasStore = useKaikasStore()
  const tokensStore = useTokensStore()

  const selection = useTokensInput({ localStorageKey: 'swap-selection' })
  const addrsReadonly = readonly(selection.addrsWritable)

  const { result: pairAddrResult } = toRefs(usePairAddress(addrsReadonly))

  const swapValidation = useSwapValidation({
    tokenA: computed(() => {
      const balance = selection.balance.tokenA
      const token = selection.tokens.tokenA
      const input = selection.wei.tokenA?.input

      return balance && token && input ? { ...token, balance, input } : null
    }),
    tokenB: computed(() => selection.tokens.tokenB),
    pairAddr: pairAddrResult,
  })

  const isValid = computed(() => swapValidation.value.kind === 'ok')
  const validationMessage = computed(() => (swapValidation.value.kind === 'err' ? swapValidation.value.message : null))

  const getAmountFor = ref<null | TokenType>(null)

  const {
    gotAmountFor,
    gettingAmountFor,
    trigger: triggerGetAmount,
  } = useGetAmount(
    computed<GetAmountProps | null>(() => {
      const amountFor = getAmountFor.value
      if (!amountFor) return null

      const referenceValue = selection.wei[mirrorTokenType(amountFor)]
      if (!referenceValue || referenceValue.input.asBigInt <= 0) return null

      const { tokenA, tokenB } = addrsReadonly
      if (!tokenA || !tokenB) return null

      if (pairAddrResult.value !== 'not-empty') return null

      return {
        tokenA,
        tokenB,
        amountFor,
        referenceValue: referenceValue.input as Wei,
      }
    }),
  )
  // const
  watch(
    [gotAmountFor, selection.tokens],
    ([result]) => {
      if (result) {
        const { type: amountFor, amount } = result
        const tokenData = selection.tokens[amountFor]
        if (tokenData) {
          debugModule('Setting computed amount %o for %o', amount, amountFor)
          const token = amount.toToken(tokenData)
          selection.input[amountFor].inputRaw = new BigNumber(token).toFixed(5) as WeiAsToken
        }
      }
    },
    { deep: true },
  )

  function getSwapPrerequisitesAnyway() {
    const { tokenA, tokenB } = selection.wei as TokensPair<TokenAddrAndWeiInput>
    invariant(tokenA && tokenB, 'Both tokens should be selected')

    const amountFor = getAmountFor.value
    invariant(amountFor, '"Amount for" should be set')

    return { tokenA, tokenB, amountFor }
  }

  const swapTask = useTask(async () => {
    const kaikas = kaikasStore.getKaikasAnyway()
    const { tokenA, tokenB, amountFor } = getSwapPrerequisitesAnyway()

    // 1. Approve amount of the tokenA
    // TODO move into Swap
    await kaikas.cfg.approveAmount(tokenA.addr, tokenA.input)

    // 2. Perform swap according to which token is "exact" and if
    // some of them is native
    const swapProps = buildSwapProps({ tokenA, tokenB, referenceToken: mirrorTokenType(amountFor) })
    const { send } = await kaikas.swap.swap(swapProps)
    await send()

    // 3. Re-fetch balances
    tokensStore.touchUserBalance()
  })

  wheneverTaskErrors(swapTask, (err) => {
    console.error(err)
    $notify({ status: Status.Error, title: `Swap failed: ${String(err)}` })
  })

  wheneverTaskSucceeds(swapTask, () => {
    $notify({ status: Status.Success, title: 'Swap succeeded!' })
  })

  function swap() {
    swapTask.run()
  }

  const swapState = useStaleIfErrorState(swapTask)

  function setToken(type: TokenType, addr: Address | null) {
    selection.input[type] = { addr, inputRaw: '' as WeiAsToken }
    triggerGetAmount(true)
  }

  function setBothTokens(pair: TokensPair<Address>) {
    selection.resetInput(pair)
    getAmountFor.value = null
  }

  function setTokenValue(type: TokenType, value: WeiAsToken) {
    selection.input[type].inputRaw = value
    getAmountFor.value = mirrorTokenType(type)
  }

  function reset() {
    selection.input.tokenA.addr = selection.input.tokenB.addr = getAmountFor.value = null
    selection.input.tokenA.inputRaw = selection.input.tokenB.inputRaw = '' as WeiAsToken
  }

  return {
    selection,

    isValid,
    validationMessage,

    swap,
    swapState,
    gettingAmountFor,
    gotAmountFor,

    setToken,
    setTokenValue,
    setBothTokens,
    reset,
  }
})

import.meta.hot?.accept(acceptHMRUpdate(useSwapStore, import.meta.hot))
