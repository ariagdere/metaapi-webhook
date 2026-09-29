'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, ColorType, IChartApi, ISeriesApi, LineStyle } from 'lightweight-charts'
import {
  Chart as ChartJS, Tooltip, LineElement, PointElement,
  LinearScale, CategoryScale, Filler, Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import EditableSlTp from '@/components/EditableSlTp'
import EditableStrategyLabel from '@/components/EditableStrategyLabel'
import LsrAnglePanel from '@/components/LsrAnglePanel'

ChartJS.register(Tooltip, LineElement, PointElement, LinearScale, CategoryScale, Filler, Legend)

interface Order {
  id: number
  analysis_id: number | null
  mt5_order_id: string
  mt5_position_id: string | null
  magic: number
  strategy_label: string
  symbol: string
  direction: string
  volume: number
  entry_price: number
  fill_price: number | null
  sl: number
  tp: number
  rr: number | null
  r_target: number | null
  r_risk: number | null
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELED'
  created_at: string
  opened_at: string | null
  closed_at?: string | null
  close_price?: number | null
  realized_pnl?: number | null
  exit_reason?: string | null
  is_manual?: boolean
  h1_ls_angle?: number | null
  m5_ls_angle?: number | null
  h1_tt_pos_angle?: number | null
  m5_tt_pos_angle?: number | null
  position_size_btc: number | null
  win_probability_v6: number | null
  win_probability_v6_reverse: number | null
  analyzed_at: string | null
  analysis_rr: string | null
}

interface Price { bid: number; ask: number; time: string }
interface AccountInfo { balance: number; currency: string }

interface Stats {
  total_orders: number; pending: number; open: number; expired: number; closed: number
  win_rate: number; tp_count: number; sl_count: number
  avg_win_r: number | null; total_win_r: number; total_r: number; total_pnl: number
  max_drawdown: number; max_consecutive_wins: number
}
interface Candle { time: number; open: number; high: number; low: number; close: number }

interface StrategyRow {
  magic: number
  strategy_label: string
  total: number
  open: number
  pending: number
  expired: number
  closed: number
  tp_count: number
  sl_count: number
  win_rate: number | null
  avg_win_r: number | null
  total_r: number
  total_pnl: number
  avg_duration_min: number | null
  max_drawdown_r: number
  max_consecutive_wins: number
}

const POLL_INTERVAL_MS = 5000

function getDisplayVolume(order: Order): number {
  return order.volume
}
function isLong(direction: string): boolean {
  return direction === 'BUY' || direction === 'LONG'
}

// Her order'in R-multiple'ini KENDI gercek entry/sl/close_price'indan hesaplar.
// orders.r_target/r_risk'e (sadece analiz-bagli/algo order'lar icin dolu, MANUAL
// order'larda hep null/varsayilan oldugu icin yanlis sonuc verir -- kazanan
// MANUAL trade R=0, kaybeden sabit R=-1 gosteriyordu) ARTIK GUVENILMIYOR.
// R sabit bir deger degil, HER order kendi risk mesafesine gore ayri hesaplanir.
// 1R'i FIYAT MESAFESI olarak degil, DOLAR cinsinden risk olarak tanimlar:
// riskUsd = |fill - sl| * volume (giris anindaki -- ya da dropdown'dan
// DUZELTILMIS -- SL'e gore). Gerceklesen R, TOPLAM realized_pnl'in ($,
// mt5_order_monitor.js'te KISMI+final kapanislarin hacim-agirlikli toplami
// olarak zaten dogru hesaplaniyor) bu SABIT 1R degerine bolunmesiyle bulunur.
// Bu yaklasim, SL sonradan (orn girise) tasinsa bile ya da islem KISMI
// kapanislarla yonetilse bile DOGRU kalir -- cunku artik "kapanis fiyatina
// olan mesafe"ye hic bakmiyoruz, sadece "ne kadar $ risk aldik, ne kadar $
// kazandik/kaybettik" oranini. TEK sart: orders.sl'in GERCEK (orijinal)
// riski yansitmasi -- degismisse, EditableSlTp dropdown'undan dogru
// tarihsel degeri secmek bu hesabi da otomatik duzeltir.
// 1R'nin dolar karsiligi -- |fill-sl| * volume. realized_pnl'e bagimli
// DEGIL, bu yuzden ACIK pozisyonlar icin de anlamli ("bu SL'e vurursa
// kac $ kaybederim" sorusuna cevap verir).
function calcRiskUsd(o: Order): number | null {
  if (o.sl == null) return null
  const entry = o.fill_price ?? o.entry_price
  const riskDist = Math.abs(entry - o.sl)
  if (riskDist <= 0) return null
  const riskUsd = riskDist * o.volume
  return riskUsd > 0 ? riskUsd : null
}

function calcOrderR(o: Order): number | null {
  if (o.realized_pnl == null) return null
  const riskUsd = calcRiskUsd(o)
  if (riskUsd == null) return null
  return o.realized_pnl / riskUsd
}

function calcPnL(order: Order, bid: number, ask: number, volume: number): number {
  const entry = order.fill_price ?? order.entry_price
  if (isLong(order.direction)) {
    return (bid - entry) * volume
  }
  return (entry - ask) * volume
}
const pnlClass = (v: number) => (v > 0 ? 'pnl-pos' : v < 0 ? 'pnl-neg' : 'pnl-zero')
const moneyColor = (v: number) => (v >= 0 ? 'var(--green)' : 'var(--red)')
const dirBadge = (d: string) => {
  if (d === 'SELL' || d === 'SHORT') return <span className="badge badge-short">{d}</span>
  if (d === 'BUY' || d === 'LONG') return <span className="badge badge-long">{d}</span>
  return <span className="badge badge-wait">{d}</span>
}
const statusBadge = (s: string) => {
  if (s === 'OPEN') return <span className="badge badge-tp">OPEN</span>
  return <span className="badge badge-pend">PENDING</span>
}
const exitBadge = (o: Order) => {
  if (o.status === 'CANCELED') {
    if (o.exit_reason === 'EXPIRED') return <span className="badge badge-exp">EXPIRED</span>
    return <span className="badge badge-pend">CANCELED</span>
  }
  const manual = o.is_manual ? ' ✋' : ''
  if (o.exit_reason === 'TP') return <span className="badge badge-tp">TP{manual}</span>
  if (o.exit_reason === 'SL') return <span className="badge badge-sl">SL{manual}</span>
  return <span className="badge badge-ne">CLOSED</span>
}
const wpColor = (v: number | null) => {
  if (v == null) return 'var(--text-3)'
  const n = Number(v)
  if (n >= 60) return 'var(--green)'
  if (n >= 50) return 'var(--amber)'
  return 'var(--red)'
}
const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—'
  return new Date(s).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
// Fiyat: tam sayiya yuvarla, decimal gosterme
const fmtPrice = (v: number | null | undefined) => {
  if (v == null) return '—'
  return Math.round(Number(v)).toString()
}
// Dakikayi "2s 15dk" formatina cevir
const fmtDuration = (mins: number) => {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`
}
// RR gosterimi: gercek SL/TP mesafesinden hesaplanan HEDEF risk/odul orani.
// r_target/r_risk'e artik bagimli degil (MANUAL order'larda hep null oldugu
// icin "-" gosteriyordu) -- entry/sl/tp'den dogrudan, her order icin ayri
// hesaplaniyor, hem acik hem kapali order'larda calisir.
const fmtRR = (order: Order) => {
  if (order.sl == null || order.tp == null) return '—'
  const entry = order.fill_price ?? order.entry_price
  const riskDist = Math.abs(entry - order.sl)
  const rewardDist = Math.abs(order.tp - entry)
  if (riskDist <= 0) return '—'
  return `1:${(rewardDist / riskDist).toFixed(2)}`
}

// lightweight-charts UTC gosterir; tarayicinin yerel offsetini ekleyerek
// eksen ve markerlari yerel saate hizalariz (tablo tr-TR ile tutarli olur).
const TZ_OFFSET_SEC = -new Date().getTimezoneOffset() * 60 // İstanbul icin +10800
const toLocalTime = (unixSec: number) => unixSec + TZ_OFFSET_SEC

// -------------------- TARIH FILTRESI --------------------
// Genel sayfa tarih filtresi. Sadece kapanan/iptal edilen (gecmis) kayitlara uygulanir;
// acik/pending pozisyonlar her zaman gosterilir (anlik durumdur, tarih araligindan bagimsiz).
function withinDateRange(dateStr: string | null | undefined, from: string, to: string): boolean {
  if (!from && !to) return true
  if (!dateStr) return true
  const d = new Date(dateStr)
  if (from) {
    const f = new Date(from + 'T00:00:00')
    if (d < f) return false
  }
  if (to) {
    const t = new Date(to + 'T23:59:59')
    if (d > t) return false
  }
  return true
}

// Istanbul (UTC+3, 2016'dan beri DST yok -- sabit kayma yeterli) saatine
// gore gunun haftaici/haftasonu oldugunu belirler -- proje genelinde
// kullanilan UTC+3 kuraliyla tutarli (bkz. naif_orchestrator.ts).
function matchesDow(dateStr: string | null | undefined, filter: 'all' | 'weekday' | 'weekend'): boolean {
  if (filter === 'all') return true
  if (!dateStr) return true
  const istanbulMs = new Date(dateStr).getTime() + 3 * 60 * 60 * 1000
  const dow = new Date(istanbulMs).getUTCDay() // 0=Pazar ... 6=Cumartesi
  const isWeekend = dow === 0 || dow === 6
  return filter === 'weekend' ? isWeekend : !isWeekend
}

// -------------------- CLIENT-SIDE AGGREGATION --------------------
// Skorkartlar ve strateji karsilastirmasi artik sunucudan degil, zaten yuklu olan
// orders+history dizilerinden hesaplaniyor. Bu sayede 3 farkli strateji secici
// (ust toggle, equity curve, karsilastirma tablosu) TEK bir hesaplama fonksiyonunu
// besliyor ve her zaman ayni sonucu uretiyor.
function computeStats(historyRows: Order[], liveRows: Order[]): Stats {
  let pending = 0, open = 0, expired = 0, closed = 0, tp = 0, sl = 0
  let totalPnl = 0, totalR = 0, winRSum = 0, winCount = 0
  const closedSeries: Array<{ t: number; r: number }> = []

  liveRows.forEach((o) => {
    if (o.status === 'PENDING') pending++
    else if (o.status === 'OPEN') open++
  })

  historyRows.forEach((o) => {
    if (o.status === 'CANCELED') {
      if (o.exit_reason === 'EXPIRED') expired++
      return
    }
    if (o.status !== 'CLOSED') return
    closed++
    if (o.exit_reason === 'TP') tp++
    else if (o.exit_reason === 'SL') sl++

    totalPnl += o.realized_pnl ?? 0

    const rVal = calcOrderR(o)
    if (rVal != null) {
      totalR += rVal
      if (rVal > 0) { winRSum += rVal; winCount++ }
      if (o.closed_at) closedSeries.push({ t: new Date(o.closed_at).getTime(), r: rVal })
    }
  })

  const totalOrders = liveRows.length + historyRows.length
  const decided = tp + sl
  const winRate = decided > 0 ? (tp / decided) * 100 : 0
  const avgWinR = winCount > 0 ? winRSum / winCount : null

  const sortedSeries = closedSeries.slice().sort((a, b) => a.t - b.t)
  let cum = 0, peak = 0, maxDD = 0, streak = 0, maxStreak = 0
  sortedSeries.forEach((s) => {
    cum += s.r
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > maxDD) maxDD = dd
    if (s.r > 0) { streak++; if (streak > maxStreak) maxStreak = streak } else streak = 0
  })

  return {
    total_orders: totalOrders, pending, open, expired, closed,
    tp_count: tp, sl_count: sl,
    win_rate: Number(winRate.toFixed(1)),
    avg_win_r: avgWinR != null ? Number(avgWinR.toFixed(2)) : null,
    total_win_r: Number(winRSum.toFixed(2)),
    total_r: Number(totalR.toFixed(2)),
    total_pnl: Number(totalPnl.toFixed(2)),
    max_drawdown: Number(maxDD.toFixed(2)),
    max_consecutive_wins: maxStreak,
  }
}

function computeStrategyComparison(orders: Order[], history: Order[]): StrategyRow[] {
  const labels = new Set<string>()
  orders.forEach((o) => labels.add(o.strategy_label))
  history.forEach((o) => labels.add(o.strategy_label))

  return Array.from(labels).map((label) => {
    const liveRows = orders.filter((o) => o.strategy_label === label)
    const histRows = history.filter((o) => o.strategy_label === label)
    const s = computeStats(histRows, liveRows)

    const durations = histRows
      .filter((o) => o.status === 'CLOSED' && o.opened_at && o.closed_at)
      .map((o) => (new Date(o.closed_at as string).getTime() - new Date(o.opened_at as string).getTime()) / 60000)
    const avgDur = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null

    const magic = liveRows[0]?.magic ?? histRows[0]?.magic ?? 0

    return {
      magic, strategy_label: label,
      total: s.total_orders, open: s.open, pending: s.pending, expired: s.expired, closed: s.closed,
      tp_count: s.tp_count, sl_count: s.sl_count, win_rate: s.win_rate, avg_win_r: s.avg_win_r,
      total_r: s.total_r, total_pnl: s.total_pnl, avg_duration_min: avgDur,
      max_drawdown_r: s.max_drawdown, max_consecutive_wins: s.max_consecutive_wins,
    }
  }).sort((a, b) => b.total - a.total)
}

function ScoreCard({ label, value, color, sub, subColor }: { label: string; value: React.ReactNode; color?: string; sub?: React.ReactNode; subColor?: string }) {
  return (
    <div className="stat-card">
      <div className="col-label" style={{ marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 500, color: color ?? 'var(--text)' }}>{value}</div>
      {sub != null && <div className="mono" style={{ fontSize: 10, marginTop: 4, color: subColor ?? 'var(--text-3)', whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  )
}

// OPEN karti icin ozel duzen: sol = adet, sag = ust uste unrealized PnL + value at risk
function OpenScoreCard({ count, unrealized, valueAtRisk }: { count: number; unrealized: number | null; valueAtRisk: number | null }) {
  return (
    <div className="stat-card" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div>
        <div className="col-label" style={{ marginBottom: 4 }}>OPEN</div>
        <div className="mono" style={{ fontSize: 18, fontWeight: 500, color: 'var(--green)' }}>{count}</div>
      </div>
      <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2, alignSelf: 'flex-end' }}>
        <div className="mono" style={{ fontSize: 9, color: unrealized != null ? moneyColor(unrealized) : 'var(--text-3)' }}>
          PnL: {unrealized != null ? `${unrealized >= 0 ? '+' : '-'}$${Math.abs(unrealized).toFixed(2)}` : '—'}
        </div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--text-3)' }}>
          VaR: {valueAtRisk != null ? `$${valueAtRisk.toFixed(2)}` : '—'}
        </div>
      </div>
    </div>
  )
}

function LiveChart({ candles, selectedOrders }: { candles: Candle[]; selectedOrders: Order[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLinesRef = useRef<any[]>([])
  const didInitialZoom = useRef(false)

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#a0a0a0', fontFamily: 'DM Mono, monospace', fontSize: 10 },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      timeScale: { borderColor: '#242424', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#242424' },
      crosshair: { mode: 0 },
      width: container.clientWidth || 600,
      height: isMobile ? 240 : 420,
    })
    const series = chart.addCandlestickSeries({
      upColor: '#4ade80', downColor: '#f87171',
      borderUpColor: '#4ade80', borderDownColor: '#f87171',
      wickUpColor: '#4ade80', wickDownColor: '#f87171',
      priceFormat: { type: 'custom', minMove: 1, formatter: (p: number) => Math.round(p).toString() },
    })
    chartRef.current = chart
    seriesRef.current = series

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)
    requestAnimationFrame(handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    if (seriesRef.current && candles.length > 0) {
      const localCandles = candles.map((c) => ({ ...c, time: toLocalTime(c.time) }))
      seriesRef.current.setData(localCandles as any)
      if (!didInitialZoom.current) {
        const visibleCount = typeof window !== 'undefined' && window.innerWidth <= 768 ? 80 : 150
        const total = localCandles.length
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - visibleCount), to: total })
        didInitialZoom.current = true
      }
    }
  }, [candles])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    priceLinesRef.current.forEach((pl) => series.removePriceLine(pl))
    priceLinesRef.current = []

    selectedOrders.forEach((o) => {
      const tag = isLong(o.direction) ? 'B' : 'S'
      const lines = [
        { price: o.entry_price, color: '#60a5fa', title: `Entry ${tag} #${o.id}`, style: o.status === 'PENDING' ? LineStyle.Dashed : LineStyle.Solid },
        { price: o.tp, color: '#4ade80', title: `TP ${tag} #${o.id}`, style: LineStyle.Dotted },
        { price: o.sl, color: '#f87171', title: `SL ${tag} #${o.id}`, style: LineStyle.Dotted },
      ]
      lines.forEach((l) => {
        const pl = series.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, axisLabelVisible: true, title: l.title })
        priceLinesRef.current.push(pl)
      })
    })

    const CANDLE_SEC = 15 * 60
    const roundToCandle = (iso: string) => {
      const ts = Math.floor(new Date(iso).getTime() / 1000)
      const rounded = Math.floor(ts / CANDLE_SEC) * CANDLE_SEC
      return toLocalTime(rounded)
    }
    const markers: any[] = []
    selectedOrders.forEach((o) => {
      const isBuy = isLong(o.direction)
      if (o.created_at) {
        markers.push({ time: roundToCandle(o.created_at), position: 'aboveBar', color: '#fbbf24', shape: 'square', text: `Order #${o.id}` })
      }
      if (o.opened_at) {
        markers.push({ time: roundToCandle(o.opened_at), position: isBuy ? 'belowBar' : 'aboveBar', color: '#60a5fa', shape: isBuy ? 'arrowUp' : 'arrowDown', text: `In #${o.id}` })
      }
      if (o.status === 'CLOSED' && o.closed_at) {
        const exitColor = o.exit_reason === 'TP' ? '#4ade80' : o.exit_reason === 'SL' ? '#f87171' : '#a0a0a0'
        markers.push({ time: roundToCandle(o.closed_at), position: isBuy ? 'aboveBar' : 'belowBar', color: exitColor, shape: 'circle', text: `Out #${o.id} ${o.exit_reason ?? ''}` })
      }
    })
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    series.setMarkers(markers)
  }, [selectedOrders, candles])

  return <div ref={containerRef} style={{ width: '100%' }} />
}

function SelectDot({ selected }: { selected: boolean }) {
  return (
    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, border: '1px solid var(--border-3)', background: selected ? 'var(--blue)' : 'transparent' }} />
  )
}

// -------------------- EQUITY CURVE (Chart.js, kategori ekseni) --------------------
// Analiz sayfasindaki Cumulative R grafigiyle ayni tasarim dili ve ayni mantik:
// tum seriler AYNI (paylasilan) gun/hafta/ay etiket listesine hizalanir (category axis),
// bu yuzden eksendeki tarih ile noktalar HER ZAMAN birebir eslesir.
type EquityPeriod = 'daily' | 'weekly' | 'monthly'

function bucketKey(date: Date, period: EquityPeriod): string {
  if (period === 'monthly') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }
  if (period === 'weekly') {
    const d = new Date(date)
    const day = (d.getDay() + 6) % 7 // 0=Pazartesi
    d.setDate(d.getDate() - day)
    return d.toLocaleDateString('sv-SE')
  }
  return date.toLocaleDateString('sv-SE')
}

function bucketLabel(key: string, period: EquityPeriod): string {
  if (period === 'monthly') {
    const [y, m] = key.split('-')
    return `${m}/${y.slice(2)}`
  }
  const d = new Date(key + 'T00:00:00')
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' })
}

function computeBucketRSums(rows: Order[], period: EquityPeriod): Map<string, number> {
  const map = new Map<string, number>()
  for (const o of rows) {
    if (o.status !== 'CLOSED') continue
    if (o.exit_reason !== 'TP' && o.exit_reason !== 'SL') continue
    if (!o.closed_at) continue
    const r = calcOrderR(o)
    if (r == null) continue
    const key = bucketKey(new Date(o.closed_at), period)
    map.set(key, (map.get(key) ?? 0) + r)
  }
  return map
}

// globalLabels'a hizali dizi doner. Ilk trade'den once null (cizgi baslamaz),
// sonrasinda kumulatif deger duz (flat) devam eder (trade olmayan gunlerde sabit kalir).
function alignSeries(rSumsByKey: Map<string, number>, globalLabels: string[]): Array<number | null> {
  let cum = 0
  let started = false
  const out: Array<number | null> = []
  for (const key of globalLabels) {
    if (rSumsByKey.has(key)) started = true
    if (!started) { out.push(null); continue }
    cum += rSumsByKey.get(key) ?? 0
    out.push(Number(cum.toFixed(4)))
  }
  return out
}

const EQUITY_LINE_COLORS = ['#f59e0b', '#3b82f6', '#a78bfa', '#f472b6', '#fbbf24']

function EquityCurveChart({ history, selectedStrategies, period }: { history: Order[]; selectedStrategies: string[]; period: EquityPeriod }) {
  const allKeys = new Set<string>()
  history.forEach((o) => {
    if (o.status === 'CLOSED' && (o.exit_reason === 'TP' || o.exit_reason === 'SL') && o.closed_at) {
      allKeys.add(bucketKey(new Date(o.closed_at), period))
    }
  })
  const globalLabels = Array.from(allKeys).sort()

  if (globalLabels.length === 0) {
    return (
      <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', padding: '40px 0', textAlign: 'center' }}>
        No closed trades yet
      </div>
    )
  }

  const displayLabels = globalLabels.map((k) => bucketLabel(k, period))

  const totalSums = computeBucketRSums(history, period)
  const totalSeries = alignSeries(totalSums, globalLabels)
  const totalFinal = totalSeries.length > 0 ? (totalSeries[totalSeries.length - 1] ?? 0) : 0
  const totalColor = totalFinal >= 0 ? '#4ade80' : '#f87171'

  const perStrategy = selectedStrategies.map((label, i) => {
    const rows = history.filter((o) => o.strategy_label === label)
    const sums = computeBucketRSums(rows, period)
    return { label, color: EQUITY_LINE_COLORS[i % EQUITY_LINE_COLORS.length], data: alignSeries(sums, globalLabels) }
  })

  const combined = selectedStrategies.length >= 2
    ? alignSeries(computeBucketRSums(history.filter((o) => selectedStrategies.includes(o.strategy_label)), period), globalLabels)
    : null

  const datasets: any[] = [
    {
      label: 'Total Account',
      data: totalSeries,
      borderColor: totalColor,
      backgroundColor: totalColor === '#4ade80' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
      borderWidth: 1.5,
      pointRadius: 0,
      pointHitRadius: 12,
      fill: true,
      tension: 0.2,
      spanGaps: true,
    },
    ...perStrategy.map((s) => ({
      label: s.label,
      data: s.data,
      borderColor: s.color,
      borderWidth: 1.2,
      borderDash: [3, 3],
      pointRadius: 0,
      pointHitRadius: 12,
      fill: false,
      tension: 0.2,
      spanGaps: false,
    })),
  ]

  if (combined) {
    datasets.push({
      label: 'Combined (selected)',
      data: combined,
      borderColor: '#ffffff',
      borderWidth: 2.5,
      borderDash: [6, 4],
      pointRadius: 0,
      pointHitRadius: 12,
      fill: false,
      tension: 0.2,
      spanGaps: false,
    })
  }

  return (
    <div style={{ height: 220 }}>
      <Line
        data={{ labels: displayLabels, datasets }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', intersect: false },
          plugins: {
            legend: {
              display: true, position: 'top', align: 'end',
              labels: { color: '#a0a0a0', font: { family: 'DM Mono', size: 9 }, boxWidth: 12, padding: 8, usePointStyle: false },
            },
            tooltip: {
              displayColors: true,
              callbacks: {
                title: (items: any) => items[0]?.label ?? '',
                label: (ctx: any) => ctx.parsed.y == null ? undefined : `${ctx.dataset.label}: ${ctx.parsed.y >= 0 ? '+' : ''}${ctx.parsed.y.toFixed(2)}R`,
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#1a1a1a' },
              ticks: { color: '#555', font: { family: 'DM Mono', size: 9 }, maxTicksLimit: 10 },
              border: { color: '#242424' },
            },
            y: {
              grid: { color: '#1a1a1a' },
              ticks: { color: '#555', font: { family: 'DM Mono', size: 9 }, callback: (v: any) => `${v}R` },
              border: { color: '#242424' },
            },
          },
        } as any}
      />
    </div>
  )
}

export default function LivePositionsPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [history, setHistory] = useState<Order[]>([])
  const [allLabels, setAllLabels] = useState<string[]>([])
  const [price, setPrice] = useState<Price | null>(null)
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELED'>('ALL')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 20

  // Tekilleştirilmiş strateji seçimi — üst toggle, equity curve ve karşılaştırma
  // tablosu AYNI bu state'i okur/yazar; hangisinden seçilirse seçilsin aynı etkiyi yapar.
  const [selectedStrategies, setSelectedStrategies] = useState<Set<string>>(new Set())
  const toggleStrategy = (label: string) => {
    setSelectedStrategies((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
    setPage(1)
  }
  const clearStrategies = () => { setSelectedStrategies(new Set()); setPage(1) }

  const [equityPeriod, setEquityPeriod] = useState<EquityPeriod>('daily')

  // Genel tarih filtresi (gecmis/kapanan kayitlara uygulanir)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dowFilter, setDowFilter] = useState<'all' | 'weekday' | 'weekend'>('all')
  const [reconcileState, setReconcileState] = useState<{ loading: boolean; result: any | null; error: string | null }>({ loading: false, result: null, error: null })
  const [fixingIds, setFixingIds] = useState<Set<string>>(new Set())
  const [fixedIds, setFixedIds] = useState<Set<string>>(new Set())

  async function fixMissingOrder(positionId: string) {
    setFixingIds((prev) => new Set(prev).add(positionId))
    try {
      const res = await fetch('/api/reconcile/fix-missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Bilinmeyen hata')
      setFixedIds((prev) => new Set(prev).add(positionId))
    } catch (err: any) {
      alert(`Order oluşturulamadı (position ${positionId}): ${err.message || 'bilinmeyen hata'}`)
    } finally {
      setFixingIds((prev) => { const next = new Set(prev); next.delete(positionId); return next })
    }
  }

  async function fixCloseOrder(orderId: number, positionId: string) {
    setFixingIds((prev) => new Set(prev).add(positionId))
    try {
      const res = await fetch('/api/reconcile/fix-closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, positionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Bilinmeyen hata')
      setFixedIds((prev) => new Set(prev).add(positionId))
    } catch (err: any) {
      alert(`Order kapatılamadı (order #${orderId}): ${err.message || 'bilinmeyen hata'}`)
    } finally {
      setFixingIds((prev) => { const next = new Set(prev); next.delete(positionId); return next })
    }
  }

  async function fixOpenOrder(positionId: string) {
    setFixingIds((prev) => new Set(prev).add(positionId))
    try {
      const res = await fetch('/api/reconcile/fix-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Bilinmeyen hata')
      setFixedIds((prev) => new Set(prev).add(positionId))
    } catch (err: any) {
      alert(`Senkronize edilemedi (position ${positionId}): ${err.message || 'bilinmeyen hata'}`)
    } finally {
      setFixingIds((prev) => { const next = new Set(prev); next.delete(positionId); return next })
    }
  }

  async function runReconcile() {
    setReconcileState({ loading: true, result: null, error: null })
    try {
      const res = await fetch('/api/reconcile?hours=24', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Bilinmeyen hata')
      setReconcileState({ loading: false, result: data, error: null })
    } catch (err: any) {
      setReconcileState({ loading: false, result: null, error: err.message || 'Mutabakat kontrolü başarısız' })
    }
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  useEffect(() => {
    let active = true
    async function fetchData() {
      try {
        const [ordersRes, priceRes, historyRes, accountRes] = await Promise.all([
          fetch('/api/orders-live', { cache: 'no-store' }),
          fetch('/api/live-price', { cache: 'no-store' }),
          fetch('/api/orders-history', { cache: 'no-store' }),
          fetch('/api/account-info', { cache: 'no-store' }),
        ])
        if (!ordersRes.ok || !priceRes.ok) throw new Error('fetch failed')
        const ordersData: Order[] = await ordersRes.json()
        const priceData: Price = await priceRes.json()
        const historyData: Order[] = historyRes.ok ? await historyRes.json() : []
        const accountData: AccountInfo | null = accountRes.ok ? await accountRes.json() : null
        if (active) {
          setOrders(ordersData); setPrice(priceData); setHistory(historyData); setAccountInfo(accountData)
          setSelectedIds((prev) => {
            const validIds = new Set([...ordersData, ...historyData].map((o) => o.id))
            const next = new Set<number>()
            prev.forEach((id) => { if (validIds.has(id)) next.add(id) })
            return next
          })
          setError(null); setLoading(false)
        }
      } catch {
        if (active) { setError('Failed to load live data'); setLoading(false) }
      }
    }
    fetchData()
    const interval = setInterval(fetchData, POLL_INTERVAL_MS)
    return () => { active = false; clearInterval(interval) }
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/strategy-labels', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (active) setAllLabels(d.labels ?? []) })
      .catch(() => {})
    return () => { active = false }
  }, [])

  // SL/TP/strategy_label dropdown'dan bir deger secildiginde, sunucu yaziminin
  // BASARILI oldugu ANLASILDIKTAN SONRA cagrilir -- bir sonraki 5sn'lik poll'u
  // beklemeden ekranda ANINDA yansisin diye orders/history state'ini yerinde
  // gunceller (DB zaten API route'ta guncellendi, burada sadece UI'i senkronize ediyoruz).
  function applyOrderPatch(orderId: number, patch: Partial<Order>) {
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...patch } : o)))
    setHistory((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...patch } : o)))
  }

  useEffect(() => {
    let active = true
    async function fetchCandles() {
      try {
        const res = await fetch('/api/candles', { cache: 'no-store' })
        if (res.ok && active) setCandles(await res.json())
      } catch {}
    }
    fetchCandles()
    const interval = setInterval(fetchCandles, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  const midPrice = price ? (price.bid + price.ask) / 2 : null
  const fmtMoney = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(0)}`

  // Tarihe gore filtrelenmis liste (skorkart/karsilastirma/tablo icin ortak
  // kaynak) -- ONCEDEN kapanis anina (closed_at) gore filtreleniyordu, artik
  // order'in ACILDIGI ana (created_at) gore. Hem acik/pending hem kapali
  // order'lara AYNI sekilde uygulanir -- "order date'e gore filtrele"
  // talebiyle tutarli olmasi icin ikisi de created_at kullanir. dowFilter
  // (haftaici/haftasonu), tarih araligina EK bir kisit olarak uygulanir.
  const dateFilteredHistory = useMemo(
    () => history.filter((o) => withinDateRange(o.created_at, dateFrom, dateTo) && matchesDow(o.created_at, dowFilter)),
    [history, dateFrom, dateTo, dowFilter]
  )
  const dateFilteredOrders = useMemo(
    () => orders.filter((o) => withinDateRange(o.created_at, dateFrom, dateTo) && matchesDow(o.created_at, dowFilter)),
    [orders, dateFrom, dateTo, dowFilter]
  )

  const matchStrategy = (o: Order) => selectedStrategies.size === 0 || selectedStrategies.has(o.strategy_label)

  const strategyFilteredHistory = useMemo(
    () => dateFilteredHistory.filter(matchStrategy),
    [dateFilteredHistory, selectedStrategies]
  )
  const strategyFilteredOrders = useMemo(
    () => dateFilteredOrders.filter(matchStrategy),
    [dateFilteredOrders, selectedStrategies]
  )

  const stats = useMemo(
    () => computeStats(strategyFilteredHistory, strategyFilteredOrders),
    [strategyFilteredHistory, strategyFilteredOrders]
  )

  // Karsilastirma tablosu her zaman TUM stratejileri gosterir (secimden bagimsiz),
  // sadece tarih filtresine uyar.
  const comparison = useMemo(
    () => computeStrategyComparison(dateFilteredOrders, dateFilteredHistory),
    [dateFilteredOrders, dateFilteredHistory]
  )

  // Acik pozisyonlarin toplam unrealized PnL'i (strateji secimine uyar) --
  // KASITLI olarak tarih filtresinden BAGIMSIZ: "su an piyasada ne var"
  // sorusuna cevap veren anlik bir ozet, "bu tarih araliginda ACILAN
  // pozisyonlarin riski" degil.
  const totalUnrealized =
    price !== null
      ? orders.filter((o) => o.status === 'OPEN' && matchStrategy(o))
          .reduce((sum, o) => sum + calcPnL(o, price.bid, price.ask, getDisplayVolume(o)), 0)
      : null

  // Acik pozisyonlarin toplam Value at Risk'i -- ayni sekilde tarih
  // filtresinden bagimsiz, anlik bir ozet.
  const totalValueAtRisk = orders
    .filter((o) => o.status === 'OPEN' && matchStrategy(o))
    .reduce((sum, o) => {
      const entry = o.fill_price ?? o.entry_price
      return sum + Math.abs(entry - o.sl) * getDisplayVolume(o)
    }, 0)

  // Birlesik liste: artik acik/pending de HER IKISI de created_at'e gore
  // ayni tarih filtresine tabi.
  const stratRows = [...dateFilteredOrders, ...dateFilteredHistory].filter(matchStrategy)
  const selectedOrders = stratRows.filter((o) => selectedIds.has(o.id))

  const filtered = stratRows.filter((o) => {
    if (statusFilter === 'ALL') return true
    if (statusFilter === 'CANCELED') return o.status === 'CANCELED'
    return o.status === statusFilter
  })

  const sorted = [...filtered].sort((a, b) => {
    const aActive = a.status === 'OPEN' || a.status === 'PENDING'
    const bActive = b.status === 'OPEN' || b.status === 'PENDING'
    if (aActive !== bActive) return aActive ? -1 : 1
    const aT = a.closed_at ? new Date(a.closed_at).getTime() : new Date(a.created_at).getTime()
    const bT = b.closed_at ? new Date(b.closed_at).getTime() : new Date(b.created_at).getTime()
    return bT - aT
  })

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paged = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const FILTERS: Array<{ key: typeof statusFilter; label: string }> = [
    { key: 'ALL', label: 'ALL' },
    { key: 'PENDING', label: 'PENDING' },
    { key: 'OPEN', label: 'OPEN' },
    { key: 'CLOSED', label: 'CLOSED' },
    { key: 'CANCELED', label: 'CANCELED' },
  ]

  const rowBadge = (o: Order) => {
    if (o.status === 'OPEN') return <span className="badge badge-tp">OPEN</span>
    if (o.status === 'PENDING') return <span className="badge badge-pend">PENDING</span>
    return exitBadge(o)
  }

  const rowPnl = (o: Order): { text: string; cls: string } => {
    if (o.status === 'OPEN' && price !== null) {
      const v = calcPnL(o, price.bid, price.ask, getDisplayVolume(o))
      return { text: `${v > 0 ? '+' : ''}${v.toFixed(2)}`, cls: pnlClass(v) }
    }
    if (o.status === 'CLOSED' && o.realized_pnl != null) {
      const v = o.realized_pnl
      return { text: `${v > 0 ? '+' : ''}${v.toFixed(2)}`, cls: pnlClass(v) }
    }
    return { text: '—', cls: 'pnl-zero' }
  }

  const equity = accountInfo != null ? accountInfo.balance + (totalUnrealized ?? 0) : null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 64 }}>
      <style>{`
        .live-scorecards { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
        .live-section-title { font-size: 11px; color: var(--text-3); letter-spacing: 0.08em; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); font-family: 'DM Mono', monospace; }
        .live-table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: 'DM Mono', monospace; }
        .live-table-wrap { overflow-x: auto; }
        .live-mobile-cards { display: none; }
        .live-date-input { background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 10px; padding: 3px 8px; font-family: 'DM Mono', monospace; }
        @media (max-width: 1200px) {
          .live-scorecards { grid-template-columns: repeat(5, minmax(0, 1fr)); }
        }
        @media (max-width: 768px) {
          .live-scorecards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .live-table-wrap { display: none; }
          .live-mobile-cards { display: flex; flex-direction: column; gap: 6px; }
          .live-mcard { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; cursor: pointer; }
          .live-mcard.selected { border-color: var(--blue); background: var(--bg-3); }
        }
      `}</style>

      <div className="container" style={{ paddingTop: 24 }}>
        <div className="live-section-title">LIVE POSITIONS</div>

        {/* Genel tarih filtresi */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="col-label" style={{ fontSize: 9 }}>DATE RANGE</span>
          <input type="date" className="live-date-input" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1) }} />
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>–</span>
          <input type="date" className="live-date-input" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1) }} />
          <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
            {(['all', 'weekday', 'weekend'] as const).map((f) => (
              <button
                key={f}
                className="filter-btn"
                style={{ fontSize: 10, padding: '3px 10px', background: dowFilter === f ? 'var(--bg-3)' : undefined }}
                onClick={() => { setDowFilter(f); setPage(1) }}
              >
                {f === 'all' ? 'Tümü' : f === 'weekday' ? 'Haftaiçi' : 'Haftasonu'}
              </button>
            ))}
          </div>
          {(dateFrom || dateTo || dowFilter !== 'all') && (
            <button className="filter-btn" style={{ fontSize: 10, padding: '3px 10px' }} onClick={() => { setDateFrom(''); setDateTo(''); setDowFilter('all'); setPage(1) }}>
              Clear
            </button>
          )}
          <span className="mono" style={{ fontSize: 9, color: 'var(--text-3)' }}>(order date'e göre — hem açık/pending hem kapalı; haftaiçi/haftasonu İstanbul saatine göre)</span>
        </div>

        {/* Mutabakat kontrolu -- MT5'in kendi deal gecmisini (son 24 saat)
            orders tablosuyla karsilastirir, streaming/resync mekanizmasindan
            BAGIMSIZ bir dogrulama katmani. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="filter-btn" style={{ fontSize: 10, padding: '3px 10px' }} onClick={runReconcile} disabled={reconcileState.loading}>
            {reconcileState.loading ? 'Kontrol ediliyor…' : 'Mutabakat Kontrolü (son 24 saat)'}
          </button>
          {reconcileState.error && (
            <span className="mono" style={{ fontSize: 10, color: 'var(--red)' }}>Hata: {reconcileState.error}</span>
          )}
          {reconcileState.result && reconcileState.result.discrepancies.filter((d: any) => !fixedIds.has(d.mt5PositionId)).length === 0 && (
            <span className="mono" style={{ fontSize: 10, color: 'var(--green)' }}>
              ✓ Sorun yok — {reconcileState.result.dealCount} kapanış deal'i ve {reconcileState.result.positionCount} açık pozisyon kontrol edildi, hepsi tutarlı.
            </span>
          )}
          {reconcileState.result && reconcileState.result.discrepancies.filter((d: any) => !fixedIds.has(d.mt5PositionId)).length > 0 && (
            <div className="mono" style={{ fontSize: 10, color: 'var(--red)', width: '100%' }}>
              <div style={{ marginBottom: 4 }}>⚠ {reconcileState.result.discrepancies.filter((d: any) => !fixedIds.has(d.mt5PositionId)).length} tutarsızlık bulundu ({reconcileState.result.dealCount} deal içinde):</div>
              {reconcileState.result.discrepancies.filter((d: any) => !fixedIds.has(d.mt5PositionId)).map((d: any, i: number) => (
                <div key={i} style={{ padding: '4px 8px', background: 'var(--bg-2)', borderRadius: 4, marginBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span>
                    {d.type === 'ORDER_MISSING' && `MT5 position ${d.mt5PositionId} (${d.symbol ?? '?'}) kapandı (hacim ${d.mt5TotalClosedVolume}), ama sistemde HİÇ order kaydı yok.`}
                    {d.type === 'SHOULD_BE_CLOSED_BUT_ISNT' && `Order #${d.orderId} (position ${d.mt5PositionId}, ${d.symbol ?? '?'}) MT5'te tam kapanmış (${d.mt5TotalClosedVolume}/${d.orderVolume}), ama sistemde hâlâ status='${d.orderStatus}'.`}
                    {d.type === 'OPEN_POSITION_MISSING' && `MT5 position ${d.mt5PositionId} (${d.symbol ?? '?'}) şu an AÇIK, ama sistemde ${d.orderId ? `status='${d.orderStatus}' olarak kayıtlı` : 'hiç kaydı yok'}.`}
                    {d.type === 'SL_TP_BLANK' && `Order #${d.orderId} (position ${d.mt5PositionId}, ${d.symbol ?? '?'}) açık, ama SL/TP bizde boş — MT5'te SL: ${d.mt5Sl ?? '—'}, TP: ${d.mt5Tp ?? '—'}.`}
                    {' '}<span style={{ color: 'var(--text-3)' }}>({d.lastDealTime})</span>
                  </span>
                  {d.type === 'ORDER_MISSING' && (
                    <button
                      className="filter-btn" style={{ fontSize: 9, padding: '2px 8px', flexShrink: 0 }}
                      disabled={fixingIds.has(d.mt5PositionId)}
                      onClick={() => fixMissingOrder(d.mt5PositionId)}>
                      {fixingIds.has(d.mt5PositionId) ? '…' : 'Oluştur'}
                    </button>
                  )}
                  {d.type === 'SHOULD_BE_CLOSED_BUT_ISNT' && (
                    <button
                      className="filter-btn" style={{ fontSize: 9, padding: '2px 8px', flexShrink: 0 }}
                      disabled={fixingIds.has(d.mt5PositionId)}
                      onClick={() => fixCloseOrder(d.orderId, d.mt5PositionId)}>
                      {fixingIds.has(d.mt5PositionId) ? '…' : 'Kapat'}
                    </button>
                  )}
                  {(d.type === 'OPEN_POSITION_MISSING' || d.type === 'SL_TP_BLANK') && (
                    <button
                      className="filter-btn" style={{ fontSize: 9, padding: '2px 8px', flexShrink: 0 }}
                      disabled={fixingIds.has(d.mt5PositionId)}
                      onClick={() => fixOpenOrder(d.mt5PositionId)}>
                      {fixingIds.has(d.mt5PositionId) ? '…' : 'Senkronize Et'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Strategy toggle bar */}
        {comparison.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="col-label" style={{ fontSize: 9, marginRight: 2 }}>STRATEGY</span>
            <button
              className={`filter-btn${selectedStrategies.size === 0 ? ' active' : ''}`}
              style={{ fontSize: 11 }}
              onClick={clearStrategies}
            >
              ALL
            </button>
            {comparison.map((s) => (
              <button
                key={s.strategy_label}
                className={`filter-btn${selectedStrategies.has(s.strategy_label) ? ' active' : ''}`}
                style={{ fontSize: 11 }}
                onClick={() => toggleStrategy(s.strategy_label)}
              >
                {s.strategy_label}
              </button>
            ))}
          </div>
        )}

        {/* Score cards */}
        {stats && (
          <div className="live-scorecards">
            <ScoreCard
              label="BALANCE"
              value={accountInfo != null ? `$${accountInfo.balance.toFixed(2)}` : '—'}
              sub={equity != null ? `Equity: $${equity.toFixed(2)}` : undefined}
              subColor={totalUnrealized != null ? moneyColor(totalUnrealized) : undefined}
            />
            <ScoreCard label="TOTAL" value={stats.total_orders} />
            <ScoreCard label="PENDING" value={stats.pending} color="var(--amber)" />
            <OpenScoreCard
              count={stats.open}
              unrealized={stats.open > 0 ? totalUnrealized : null}
              valueAtRisk={stats.open > 0 ? totalValueAtRisk : null}
            />
            <ScoreCard label="EXPIRED" value={stats.expired} color="var(--text-2)" />
            <ScoreCard label="WIN RATE" value={`%${stats.win_rate.toFixed(1)}`} color={wpColor(stats.win_rate)} />
            <ScoreCard
              label="TP HIT"
              value={stats.tp_count}
              color="var(--green)"
              sub={`Max Cons: ${stats.max_consecutive_wins}`}
            />
            <ScoreCard
              label="SL HIT"
              value={stats.sl_count}
              color="var(--red)"
              sub={`Max DD: -${stats.max_drawdown.toFixed(2)}R`}
            />
            <ScoreCard
              label="TOTAL R"
              value={`${stats.total_r >= 0 ? '+' : ''}${stats.total_r.toFixed(2)}R`}
              color={moneyColor(stats.total_r)}
              sub={stats.avg_win_r != null ? `Avg: +${stats.avg_win_r.toFixed(2)}R` : 'Avg: —'}
            />
            <ScoreCard
              label="TOTAL P&L"
              value={fmtMoney(stats.total_pnl)}
              color={moneyColor(stats.total_pnl)}
              sub={
                totalUnrealized != null
                  ? `${(stats.total_pnl + totalUnrealized) >= 0 ? '+' : '-'}$${Math.abs(stats.total_pnl + totalUnrealized).toFixed(2)}`
                  : undefined
              }
              subColor={totalUnrealized != null ? moneyColor(stats.total_pnl + totalUnrealized) : undefined}
            />
          </div>
        )}

        {error && <div className="mono" style={{ color: 'var(--red)', fontSize: 11, marginBottom: 12 }}>{error}</div>}

        {/* Chart */}
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="col-label">
              BTCUSDT — 15m
              {selectedOrders.length > 0 && <span style={{ color: 'var(--blue)', marginLeft: 8 }}>· {selectedOrders.length} selected</span>}
            </div>
            {price && <span className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>{Math.round((price.bid + price.ask) / 2)}</span>}
          </div>
          <LiveChart candles={candles} selectedOrders={selectedOrders} />
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 8 }}>
            Select a position from the table below to view its zones and entry/exit markers
          </div>
        </div>

        {/* LSR açı panelleri */}
        <LsrAnglePanel />

        {/* Equity curve */}
        {comparison.length > 0 && (
          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="col-label">EQUITY CURVE (R)</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                    <button
                      key={p}
                      className={`filter-btn${equityPeriod === p ? ' active' : ''}`}
                      style={{ fontSize: 9, padding: '2px 8px' }}
                      onClick={() => setEquityPeriod(p)}
                    >
                      {p === 'daily' ? 'Daily' : p === 'weekly' ? 'Weekly' : 'Monthly'}
                    </button>
                  ))}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 9, color: 'var(--text-3)' }}>
                solid = total account{selectedStrategies.size > 0 ? ' · dotted = selected' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {comparison.map((s) => (
                <button
                  key={s.strategy_label}
                  className={`filter-btn${selectedStrategies.has(s.strategy_label) ? ' active' : ''}`}
                  style={{ fontSize: 11 }}
                  onClick={() => toggleStrategy(s.strategy_label)}
                >
                  {s.strategy_label}
                </button>
              ))}
            </div>
            <EquityCurveChart history={dateFilteredHistory} selectedStrategies={Array.from(selectedStrategies)} period={equityPeriod} />
          </div>
        )}

        {/* Strategy comparison */}
        {comparison.length > 0 && (
          <>
            <div className="live-section-title">STRATEGY COMPARISON</div>
            <div className="card" style={{ padding: 16, marginBottom: 24, overflowX: 'auto' }}>
              <table className="live-table" style={{ minWidth: 1100 }}>
                <thead>
                  <tr>
                    {['Strategy', 'Total', 'Open', 'Pend', 'Exp', 'Closed', 'TP', 'SL', 'Win%', 'Avg Win R', 'Total R', 'Total P&L', 'Avg Dur', 'Max DD', 'Cons Win'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', color: 'var(--text-3)', paddingBottom: 8, fontWeight: 400, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((s) => {
                    const active = selectedStrategies.has(s.strategy_label)
                    return (
                      <tr
                        key={s.strategy_label}
                        onClick={() => toggleStrategy(s.strategy_label)}
                        style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: active ? 'var(--bg-3)' : 'transparent' }}
                      >
                        <td style={{ padding: '6px 0', color: 'var(--text-2)' }}>{s.strategy_label}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{s.total}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--green)' }}>{s.open}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--amber)' }}>{s.pending}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-3)' }}>{s.expired}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{s.closed}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--green)' }}>{s.tp_count}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--red)' }}>{s.sl_count}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: wpColor(s.win_rate) }}>{s.win_rate != null ? `%${s.win_rate.toFixed(1)}` : '—'}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--green)' }}>{s.avg_win_r != null ? `+${s.avg_win_r.toFixed(2)}R` : '—'}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: moneyColor(s.total_r) }}>{`${s.total_r >= 0 ? '+' : ''}${s.total_r.toFixed(2)}R`}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: moneyColor(s.total_pnl) }}>{`${s.total_pnl >= 0 ? '+' : '-'}$${Math.abs(s.total_pnl).toFixed(0)}`}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-3)' }}>{s.avg_duration_min != null ? fmtDuration(s.avg_duration_min) : '—'}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--red)' }}>{`-${s.max_drawdown_r.toFixed(2)}R`}</td>
                        <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{s.max_consecutive_wins}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 8 }}>
                Click a row to toggle that strategy (affects table, cards and equity curve)
              </div>
            </div>
          </>
        )}

        {/* Status filter toggles */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`filter-btn${statusFilter === f.key ? ' active' : ''}`}
                style={{ fontSize: 11 }}
                onClick={() => { setStatusFilter(f.key); setPage(1) }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <a href="/api/orders-export" className="filter-btn" style={{ fontSize: 11, textDecoration: 'none' }}>
            ⬇ CSV
          </a>
        </div>

        {/* Unified table */}
        <div className="card" style={{ padding: 16 }}>
          {loading && <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', padding: 20, textAlign: 'center' }}>loading...</div>}
          {!loading && sorted.length === 0 && <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', padding: 20, textAlign: 'center' }}>no positions</div>}

          {sorted.length > 0 && (
            <>
              {/* Desktop table */}
              <div className="live-table-wrap">
                <table className="live-table" style={{ minWidth: 1160 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 28, paddingBottom: 8 }} />
                      {['Order Date', 'Entry Date', 'Close Date', 'Strategy', 'Status', 'Dir', 'Volume', 'Entry', 'Fill', 'Exit', 'SL', 'TP', 'Risk$', 'RR', 'PnL ($)', 'Gerç. R', '1h LS°', '5m LS°', '1h TT°', '5m TT°'].map((h, i) => (
                        <th key={h} style={{ textAlign: i <= 3 ? 'left' : 'right', color: 'var(--text-3)', paddingBottom: 8, fontWeight: 400, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((order) => {
                      const selected = selectedIds.has(order.id)
                      const displayVolume = getDisplayVolume(order)
                      const pnl = rowPnl(order)
                      const rVal = calcOrderR(order)
                      const riskUsdVal = calcRiskUsd(order)
                      return (
                        <tr key={order.id} onClick={() => toggleSelect(order.id)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: selected ? 'var(--bg-3)' : 'transparent' }}>
                          <td style={{ padding: '6px 0', textAlign: 'center' }}><SelectDot selected={selected} /></td>
                          <td style={{ padding: '6px 0', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtDate(order.created_at)}</td>
                          <td style={{ padding: '6px 0', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtDate(order.opened_at)}</td>
                          <td style={{ padding: '6px 0', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtDate(order.closed_at)}</td>
                          <td style={{ padding: '6px 0', color: 'var(--text-2)' }}>
                            <EditableStrategyLabel orderId={order.id} currentLabel={order.strategy_label} allLabels={allLabels}
                              onUpdated={(v) => applyOrderPatch(order.id, { strategy_label: v })}
                              onNewLabelAdded={(v) => setAllLabels((prev) => [...prev, v].sort())} />
                          </td>
                          <td style={{ padding: '6px 0', textAlign: 'right' }}>{rowBadge(order)}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right' }}>{dirBadge(order.direction)}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{displayVolume}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{fmtPrice(order.entry_price)}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-3)' }}>{fmtPrice(order.fill_price)}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{fmtPrice(order.close_price)}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--red)' }}>
                            <EditableSlTp orderId={order.id} field="sl" currentValue={order.sl} color="var(--red)" fmtPrice={fmtPrice}
                              onUpdated={(v) => applyOrderPatch(order.id, { sl: v })} />
                          </td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--green)' }}>
                            <EditableSlTp orderId={order.id} field="tp" currentValue={order.tp} color="var(--green)" fmtPrice={fmtPrice}
                              onUpdated={(v) => applyOrderPatch(order.id, { tp: v })} />
                          </td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{riskUsdVal != null ? `$${riskUsdVal.toFixed(2)}` : '—'}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-2)' }}>{fmtRR(order)}</td>
                          <td className={`mono ${pnl.cls}`} style={{ padding: '6px 0', textAlign: 'right' }}>{pnl.text}</td>
                          <td className="mono" style={{ padding: '6px 0', textAlign: 'right', color: rVal == null ? 'var(--text-3)' : moneyColor(rVal) }}>
                            {rVal != null ? `${rVal >= 0 ? '+' : ''}${rVal.toFixed(2)}R` : '—'}
                          </td>
                          {[order.h1_ls_angle, order.m5_ls_angle, order.h1_tt_pos_angle, order.m5_tt_pos_angle].map((a, i) => (
                            <td key={i} className="mono" style={{ padding: '6px 0', textAlign: 'right', color: a == null ? 'var(--text-3)' : (a > 5 ? 'var(--green)' : a < -5 ? 'var(--red)' : 'var(--text-2)') }}>
                              {a != null ? `${a >= 0 ? '+' : ''}${a.toFixed(1)}°` : '—'}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="live-mobile-cards">
                {paged.map((order) => {
                  const selected = selectedIds.has(order.id)
                  const displayVolume = getDisplayVolume(order)
                  const pnl = rowPnl(order)
                  const rVal = calcOrderR(order)
                  const riskUsdVal = calcRiskUsd(order)
                  return (
                    <div key={order.id} className={`live-mcard${selected ? ' selected' : ''}`} onClick={() => toggleSelect(order.id)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <SelectDot selected={selected} />
                          {dirBadge(order.direction)}
                          {rowBadge(order)}
                        </div>
                        <span className={`mono ${pnl.cls}`} style={{ fontSize: 13, fontWeight: 600 }}>
                          {pnl.text === '—' ? '—' : `${pnl.text.startsWith('-') ? '-' : '+'}$${pnl.text.replace(/^[+-]/, '')}`}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'DM Mono, monospace', marginBottom: 6 }}>
                        <EditableStrategyLabel orderId={order.id} currentLabel={order.strategy_label} allLabels={allLabels}
                          onUpdated={(v) => applyOrderPatch(order.id, { strategy_label: v })}
                          onNewLabelAdded={(v) => setAllLabels((prev) => [...prev, v].sort())} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                        <div><span className="col-label">Entry </span><span style={{ color: 'var(--text-2)' }}>{fmtPrice(order.entry_price)}</span></div>
                        <div><span className="col-label">Fill </span><span style={{ color: 'var(--text-3)' }}>{fmtPrice(order.fill_price)}</span></div>
                        <div><span className="col-label">Exit </span><span style={{ color: 'var(--text-2)' }}>{fmtPrice(order.close_price)}</span></div>
                        <div><span className="col-label">Vol </span><span style={{ color: 'var(--text-2)' }}>{displayVolume}</span></div>
                        <div><span className="col-label">SL </span><EditableSlTp orderId={order.id} field="sl" currentValue={order.sl} color="var(--red)" fmtPrice={fmtPrice}
                          onUpdated={(v) => applyOrderPatch(order.id, { sl: v })} /></div>
                        <div><span className="col-label">TP </span><EditableSlTp orderId={order.id} field="tp" currentValue={order.tp} color="var(--green)" fmtPrice={fmtPrice}
                          onUpdated={(v) => applyOrderPatch(order.id, { tp: v })} /></div>
                        <div><span className="col-label">Risk$ </span><span style={{ color: 'var(--text-2)' }}>{riskUsdVal != null ? `$${riskUsdVal.toFixed(2)}` : '—'}</span></div>
                        <div><span className="col-label">RR </span><span style={{ color: 'var(--text-2)' }}>{fmtRR(order)}</span></div>
                        <div><span className="col-label">Gerç. R </span><span style={{ color: rVal == null ? 'var(--text-3)' : moneyColor(rVal) }}>{rVal != null ? `${rVal >= 0 ? '+' : ''}${rVal.toFixed(2)}R` : '—'}</span></div>
                        <div><span className="col-label">Order D </span><span style={{ color: 'var(--text-3)' }}>{fmtDate(order.created_at)}</span></div>
                        <div><span className="col-label">Entry D </span><span style={{ color: 'var(--text-3)' }}>{fmtDate(order.opened_at)}</span></div>
                        <div><span className="col-label">Close D </span><span style={{ color: 'var(--text-3)' }}>{fmtDate(order.closed_at)}</span></div>
                        {([['1h LS', order.h1_ls_angle], ['5m LS', order.m5_ls_angle], ['1h TT', order.h1_tt_pos_angle], ['5m TT', order.m5_tt_pos_angle]] as const).map(([label, a]) => (
                          <div key={label}>
                            <span className="col-label">{label} </span>
                            <span style={{ color: a == null ? 'var(--text-3)' : (a > 5 ? 'var(--green)' : a < -5 ? 'var(--red)' : 'var(--text-2)') }}>
                              {a != null ? `${a >= 0 ? '+' : ''}${a.toFixed(1)}°` : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* Pagination */}
        {sorted.length > PAGE_SIZE && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <button
              className="filter-btn"
              style={{ fontSize: 11 }}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              ← Prev
            </button>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)', padding: '0 8px' }}>
              {currentPage} / {totalPages}
              <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>({sorted.length} total)</span>
            </span>
            <button
              className="filter-btn"
              style={{ fontSize: 11 }}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next →
            </button>
          </div>
        )}

        <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 8, textAlign: 'right' }}>
          updates every {POLL_INTERVAL_MS / 1000}s
        </div>
      </div>
    </div>
  )
}
