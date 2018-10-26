const nest = require('depnest')
const { h } = require('mutant')
const Scroller = require('pull-scroll')
const pull = require('pull-stream')

exports.gives = nest({
  'app.html.menuItem': true,
  'app.page.thankful': true
})

exports.needs = nest({
  'app.html.scroller': 'first',
  'app.sync.goTo': 'first',
  'keys.sync.id': 'first',
  'channel.obs.subscribed': 'first',
  'contact.obs.following': 'first',
  'sbot.pull.log': 'first',
  'sbot.pull.stream': 'first',
  'sbot.async.get': 'first',
  'message.html.render': 'first'
})

exports.create = function (api) {
  return nest({
    'app.html.menuItem': menuItem,
    'app.page.thankful': page
  })

  function menuItem () {
    return h('a', {
      style: { order: 1 },
      'ev-click': () => api.app.sync.goTo({ page: 'thankful' })
    }, '/thankful')
  }

  function getVotes (cb) {
    const myKey = api.keys.sync.id()

    return pull(
      api.sbot.pull.stream(server => {
        return server.query.read({
          limit: 10000,
          reverse: true,
          query:
          // Gets all votes/likes made by you
            [{ $filter: {
              value:
                {
                  // TODO: filter for the last month only
                  author: myKey,
                  content: {
                    type: 'vote'
                  }
                }
            } },
            {
              // Extracts the liked post's link
              $map: ['value', 'content', 'vote', 'link']
            }
            ]
        })
      }),
      pull.asyncMap((postLink, cb) => {
        // Takes the link of the liked post
        api.sbot.async.get(postLink, (err, post) => {
          if (err) console.error('asyncMap error', err)
          // And extracts the author of it
          cb(null, post.author)
        })
      })
    )
  }

  function page (location) {
    let top = [
      h('button', {
        'ev-click': draw
      }, 'Go!')
    ]

    const { container, content } = api.app.html.scroller({ prepend: top })

    function draw () {
      // reset
      container.scroll(0)
      content.innerHTML = ''

      pull(
        getVotes(),
        Scroller(container, content, text => h('p', text))
      )
    }

    container.title = '/thankful'
    return container
  }
}
