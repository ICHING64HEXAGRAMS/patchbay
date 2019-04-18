const nest = require('depnest')
const { h, Value, Dict, dictToCollection, onceTrue, computed, watch, watchAll, throttle, resolve } = require('mutant')
const Chart = require('chart.js')
const pull = require('pull-stream')
const { isInvite } = require('ssb-ref')

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

const GRAPH_Y_STEP = 50
const GRAPH_Y_MIN = 100

exports.gives = nest({
  'app.html.menuItem': true,
  'app.page.network': true
})

exports.needs = nest({
  'about.html.avatar': 'first',
  'app.html.scroller': 'first',
  'app.sync.goTo': 'first',
  'sbot.obs.connection': 'first',
  'sbot.obs.localPeers': 'first',
  'sbot.obs.connectedPeers': 'first'
})

exports.create = function (api) {
  return nest({
    'app.html.menuItem': menuItem,
    'app.page.network': networkPage
  })

  function menuItem () {
    return h('a', {
      'ev-click': () => api.app.sync.goTo({ page: 'network' })
    }, '/network')
  }

  function networkPage (location) {
    const minsPerStep = 10
    const scale = 1 * DAY

    const state = buildState({ api, minsPerStep, scale })
    const canvas = h('canvas', { height: 500, width: 1200, style: { height: '500px', width: '1200px' } })

    const inputInvite = ev => {
      state.inviteResult.set(null)
      const invite = ev.target.value.replace(/^\s*"?/, '').replace(/"?\s*$/, '')
      if (!isInvite(invite)) {
        state.invite.set()
        return
      }

      ev.target.value = invite
      state.invite.set(invite)
    }
    const useInvite = () => {
      state.inviteProcessing.set(true)

      onceTrue(api.sbot.obs.connection, server => {
        server.invite.accept(resolve(state.invite), (err, data) => {
          state.inviteProcessing.set(false)
          state.invite.set()

          if (err) {
            state.inviteResult.set(false)
            console.error(err)
            return
          }
          state.inviteResult.set(true)
          console.log(data)
        })
      })
    }

    const page = h('NetworkPage', [
      h('div.container', [
        h('h1', 'Network'),
        h('section', [
          h('h2', [
            'Local Peers',
            h('i.fa.fa-question-circle-o', { title: 'these are people on the same WiFi/ LAN as you right now. You might not know some of them yet, but you can click through to find out more about them and follow them if you like.' })
          ]),
          computed(state.localPeers, peers => {
            if (!peers.length) return h('p', 'No local peers (on same wifi/ LAN)')

            return peers.map(peer => api.about.html.avatar(peer))
          })
        ]),
        h('section', [
          h('h2', [
            'Remote Peers',
            h('i.fa.fa-question-circle-o', { title: 'these are peers which have fixed addresses, and are likely friends of friends (a.k.a. pubs)' })
          ]),
          computed(state.remotePeers, peers => {
            if (!peers.length) return h('p', 'No remote peers connected')

            return peers.map(peer => api.about.html.avatar(peer))
          }),
          h('div.invite', [
            h('input', {
              'placeholder': 'invite code for a remote peer (pub)',
              'ev-input': inputInvite
            }),
            computed([state.invite, state.inviteProcessing], (invite, processing) => {
              if (processing) return h('i.fa.fa-spinner.fa-pulse')
              if (invite) return h('button -primary', { 'ev-click': useInvite }, 'use invite')

              return h('button', { disabled: 'disabled', title: 'not a valid invite code' }, 'use invite')
            }),
            computed(state.inviteResult, result => {
              if (result === null) return

              return result
                ? h('i.fa.fa-check')
                : h('i.fa.fa-times')
            })
          ])
        ]),
        h('section', [
          h('h2', 'My state'),
          // mix: hello friend, this area is a total Work In Progress. It's a mess but useful diagnostics.
          // Let's redesign and revisit it aye!
          h('div', ['My sequence: ', state.seq]),
          h('div', [
            'Replicated:',
            h('div', computed([state.seq, dictToCollection(state.replication)], (seq, replication) => {
              return replication.map(r => {
                if (!r.value.replicating) {
                  return h('div', [
                    h('code', r.key),
                    ' no ebt data'
                  ])
                }

                const { requested, sent } = r.value.replicating
                // TODO report that r.value.seq is NOT the current local value of the seq (well it's ok, just just gets out of sync)
                // const reqDiff = requested - r.value.seq
                const reqDiff = requested - seq
                const sentDiff = sent - seq

                return h('div', [
                  h('code', r.key),
                  ` - requested: ${requested} `,
                  reqDiff === 0 ? h('i.fa.fa-check-circle-o') : `(${reqDiff})`,
                  `, sent: ${sent} `,
                  sentDiff === 0 ? h('i.fa.fa-check-circle-o') : `(${sentDiff})`
                ])
              })
            }))
          ])
        ]),
        h('section', [
          h('h2', [
            'Received Messages',
            h('i.fa.fa-question-circle-o', {
              title: `Messages received per ${minsPerStep}-minute block over the last ${scale / DAY} days`
            })
          ]),
          canvas
        ])
      ])
    ])

    initialiseChart({ canvas, state })

    var { container } = api.app.html.scroller({ prepend: page })
    container.title = '/network'
    return container
  }
}

function initialiseChart ({ canvas, state: { data, range } }) {
  var chart = new Chart(canvas.getContext('2d'), chartConfig(range))

  watch(range, ({ lower, upper }) => {
    // set horizontal scale
    chart.options.scales.xAxes[0].time.min = lower
    chart.options.scales.xAxes[0].time.max = upper
    chart.update()
  })

  watchAll([throttle(data, 300), range], (data, { lower, upper }) => {
    const _data = Object.keys(data)
      .sort((a, b) => a < b ? -1 : +1)
      .map(ts => {
        return {
          t: Number(ts), // NOTE - might need to offset by a half-step ?
          y: data[ts]
        }
      })

    // update chard data
    chart.data.datasets[0].data = _data

    // scales the height of the graph (to the visible data)!
    const slice = _data
      .filter(d => d.t >= lower && d.t < upper)
      .map(d => d.y)
      .sort((a, b) => a > b ? -1 : +1)

    var h = slice[0]
    if (!h || h < GRAPH_Y_MIN) h = GRAPH_Y_MIN // min-height
    else h = h + (GRAPH_Y_STEP - h % GRAPH_Y_STEP) // round height to multiples of GRAPH_Y_STEP
    chart.options.scales.yAxes[0].ticks.max = h

    chart.update()
  })
}

// ///// HELPERS /////

function buildState ({ api, minsPerStep, scale }) {
  // build localPeers, remotePeers
  const localPeers = throttle(api.sbot.obs.localPeers(), 1000)
  const remotePeers = computed([localPeers, throttle(api.sbot.obs.connectedPeers(), 1000)], (local, connected) => {
    return connected.filter(peer => !local.includes(peer))
  })

  // build seq, replication (my current state, and replicated state)
  const seq = Value()
  const replication = Dict({})
  onceTrue(api.sbot.obs.connection, server => {
    setInterval(() => {
      // TODO check ebt docs if this is best method
      server.ebt.peerStatus(server.id, (err, data) => {
        if (err) return console.error(err)

        seq.set(data.seq)
        for (var peer in data.peers) {
          replication.put(peer, data.peers[peer])
        }
      })
    }, 5e3)
  })

  // build data, range
  const data = Dict({
    [toTimeBlock(Date.now(), minsPerStep) + minsPerStep * MINUTE]: 0,
    [toTimeBlock(Date.now(), minsPerStep) + minsPerStep * MINUTE - scale]: 0
  })
  onceTrue(api.sbot.obs.connection, server => {
    getData({ data, server, minsPerStep, scale })
  })

  const latest = Value(toTimeBlock(Date.now(), minsPerStep))
  // start of the most recent bar
  setInterval(() => {
    latest.set(toTimeBlock(Date.now(), minsPerStep))
  }, minsPerStep / 4 * MINUTE)

  const range = computed([latest], (latest) => {
    return {
      upper: latest + minsPerStep * MINUTE,
      lower: latest + minsPerStep * MINUTE - scale
    }
  })
  return {
    localPeers,
    remotePeers,
    seq,
    replication,
    data, // TODO rename this !!
    range,
    invite: Value(),
    inviteProcessing: Value(false),
    inviteResult: Value(null)
  }
}

function getData ({ data, server, minsPerStep, scale }) {
  const upperEnd = toTimeBlock(Date.now(), minsPerStep) + minsPerStep * MINUTE
  const lowerBound = upperEnd - scale

  const query = [
    {
      $filter: {
        timestamp: { $gte: lowerBound }
      }
    }, {
      $filter: {
        value: {
          author: { $ne: server.id }
        }
      }
    }, {
      $map: {
        ts: ['timestamp']
      }
    }
  ]

  pull(
    server.query.read({ query, live: true }),
    pull.filter(m => !m.sync),
    pull.map(m => toTimeBlock(m.ts, minsPerStep)),
    pull.drain(ts => {
      if (data.has(ts)) data.put(ts, data.get(ts) + 1)
      else data.put(ts, 1)
    })
  )
}

function toTimeBlock (ts, minsPerStep) {
  return Math.floor(ts / (minsPerStep * MINUTE)) * (minsPerStep * MINUTE)
}

function chartConfig ({ lower, upper }) {
  const barColor = 'hsla(215, 57%, 60%, 1)'

  return {
    type: 'bar',
    data: {
      datasets: [{
        backgroundColor: barColor,
        borderColor: barColor,
        data: []
      }]
    },
    options: {
      legend: {
        display: false
      },
      scales: {
        xAxes: [{
          type: 'time',
          distribution: 'linear',
          time: {
            // unit: 'day',
            // min: lower,
            // max: upper,
            // tooltipFormat: 'MMMM D',
            // stepSize: 7
            unit: 'minute',
            min: lower,
            max: upper,
            tooltipFormat: 'HH:mm',
            stepSize: 4 * 60
            // stepSize: 240
          },
          bounds: 'ticks',
          ticks: {
            // maxTicksLimit: 4 // already disabled
          },
          gridLines: {
            display: false
          }
          // maxBarThickness: 2
        }],

        yAxes: [{
          ticks: {
            min: 0,
            stepSize: GRAPH_Y_STEP,
            suggestedMax: GRAPH_Y_MIN
          }
        }]
      },
      animation: {
        // duration: 300
      }
    }
  }
}
