import test from 'ava'
import nock from 'nock'
import { Tags, MockTracer, initGlobalTracer } from 'opentracing'
import sinon from 'sinon'
import otGot from './src/index'

test.serial('has a body with parent span and globaltracer', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  initGlobalTracer(tracer)
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    tracingOptions: {
      parentSpan: parent,
    },
  })
  initGlobalTracer(null)
  t.truthy(scope.isDone())
})

test('has a body with no options', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')
  t.is((await otGot('https://whg.no')).body, 'OK')
  t.truthy(scope.isDone())
})

test('has a body with parent span', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')

  t.is(
    (await otGot('https://whg.no', {
      tracingOptions: {
        parentSpan: parent,
      },
    })).body,
    'OK',
  )
  t.truthy(scope.isDone())
})

test('has a body with parent span and tracer', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  t.is(
    (await otGot('https://whg.no', {
      tracingOptions: {
        parentSpan: parent,
        tracer,
      },
    })).body,
    'OK',
  )

  t.truthy(scope.isDone())
})

test('has a child span', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    tracingOptions: {
      parentSpan: parent,
      tracer,
    },
  })

  const report = tracer.report()
  t.is(report.spans.length, 2)

  t.truthy(scope.isDone())
})

test('logs timings', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    tracingOptions: {
      parentSpan: parent,
      tracer,
    },
  })

  const report = tracer.report()

  t.is(report.spans[1]['_logs'][0].fields.body, undefined)
  t.is(report.spans[1]['_logs'][1].fields.event, 'start')
  t.is(report.spans[1]['_logs'][2].fields.event, 'socket')
  t.is(report.spans[1]['_logs'][3].fields.event, 'lookup')
  t.is(report.spans[1]['_logs'][4].fields.event, 'connect')
  t.is(report.spans[1]['_logs'][5].fields.event, 'upload')
  t.is(report.spans[1]['_logs'][6].fields.event, 'response')
  t.is(report.spans[1]['_logs'][7].fields.event, 'end')

  t.truthy(scope.isDone())
})

test('logs body', async t => {
  const scope = nock('https://whg.no')
    .post('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    method: 'POST',
    body: 'This is a body.',
    tracingOptions: {
      parentSpan: parent,
      tracer,
    },
  })

  const report = tracer.report()
  t.is(report.spans[1]['_logs'][0].fields.body, 'This is a body.')

  t.truthy(scope.isDone())
})

test('logs retries', async t => {
  const scope = nock('https://whg.no')
    .get('/error')
    .times(3)
    .reply(500, 'Internal Server Error')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await t.throwsAsync(
    otGot('https://whg.no/error', {
      tracingOptions: {
        parentSpan: parent,
        tracer,
      },
      retry: 2,
    }),
  )
  const report = tracer.report()
  let retries = 0

  report.spans[1]['_logs'].forEach(log => {
    Object.keys(log.fields).forEach(key => {
      if (key === 'http.retry_count') retries += 1
    })
  })
  t.is(retries, 2)

  t.truthy(scope.isDone())
})

test('calls passed in beforeRetry hooks and predefined hook', async t => {
  const scope = nock('https://whg.no')
    .get('/error')
    .times(2)
    .reply(500, 'Internal Server Error')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  let retries = 0

  await t.throwsAsync(
    otGot('https://whg.no/error', {
      tracingOptions: {
        parentSpan: parent,
        tracer,
      },
      retry: 2,
      hooks: {
        beforeRetry: [
          (options, error, retryCount) => {
            retries = retryCount
          },
        ],
      },
    }),
  )

  const report = tracer.report()
  let loggedRetries = 0

  report.spans[1]['_logs'].forEach(log => {
    Object.keys(log.fields).forEach(key => {
      if (key === 'http.retry_count') loggedRetries += 1
    })
  })

  t.is(loggedRetries, 2)
  t.is(retries, 2)

  t.truthy(scope.isDone())
})

test('does not finish parent span', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    tracingOptions: {
      parentSpan: parent,
      tracer,
    },
  })

  const report = tracer.report()

  t.is(report.spans[0]._finishMs, 0)

  t.truthy(scope.isDone())
})

test('finishes parent span', async t => {
  const scope = nock('https://whg.no')
    .get('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    tracingOptions: {
      parentSpan: parent,
      tracer,
      closeParentSpan: true,
    },
  })

  t.not(tracer['_spans'][0]._finishMs, 0)

  t.truthy(scope.isDone())
})

test('finishes parent span if error', async t => {
  const scope = nock('https://whg.no')
    .get('/errorParent')
    .reply(500, 'Internal Server Error')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await t.throwsAsync(
    otGot('https://whg.no/errorParent', {
      tracingOptions: {
        parentSpan: parent,
        tracer,
        closeParentSpan: true,
      },
      retry: 0,
    }),
  )

  t.not(tracer['_spans'][0]._finishMs, 0)

  t.truthy(scope.isDone())
})

test('inject headers', async t => {
  let reqHeaders = null
  const scope = nock('https://whg.no')
    .get('/inject')
    .reply(function(uri, requestBody) {
      reqHeaders = this.req.headers
    })

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  const stub = sinon.stub(tracer, 'inject').callsFake(function(span, format, carrier) {
    carrier.trace = span._operationName
  })

  await otGot('https://whg.no/inject', {
    tracingOptions: {
      parentSpan: parent,
      tracer,
      injectHeaders: true,
    },
  })

  t.is(reqHeaders.trace, 'HTTP GET')

  t.truthy(scope.isDone())
})

test('sets tags for successfull request', async t => {
  const scope = nock('https://whg.no')
    .post('/')
    .reply(200, 'OK')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await otGot('https://whg.no', {
    method: 'POST',
    body: 'This is a body.',
    tracingOptions: {
      parentSpan: parent,
      tracer,
    },
  })

  const report = tracer.report()
  const tags = report.spans[1].tags()

  t.is(tags[Tags.SPAN_KIND], Tags.SPAN_KIND_RPC_CLIENT)
  t.truthy(tags[Tags.HTTP_URL])
  t.truthy(tags[Tags.HTTP_METHOD])
  t.is(tags[Tags.COMPONENT], 'ot-got')
  t.is(tags[Tags.HTTP_STATUS_CODE], 200)

  t.truthy(scope.isDone())
})

test('sets tags for failed request', async t => {
  const scope = nock('https://whg.no')
    .get('/tags')
    .reply(500, 'Internal Server Error')

  const tracer = new MockTracer()
  const parent = tracer.startSpan('parent_span')
  await t.throwsAsync(
    otGot('https://whg.no/tags', {
      method: 'GET',
      tracingOptions: {
        parentSpan: parent,
        tracer,
      },
      retry: 0,
    }),
  )

  const report = tracer.report()
  const tags = report.spans[1].tags()

  t.is(tags[Tags.SPAN_KIND], Tags.SPAN_KIND_RPC_CLIENT)
  t.truthy(tags[Tags.HTTP_URL])
  t.truthy(tags[Tags.HTTP_METHOD])
  t.is(tags[Tags.COMPONENT], 'ot-got')
  t.is(tags[Tags.HTTP_STATUS_CODE], 500)
  t.is(tags[Tags.ERROR], true)

  t.truthy(scope.isDone())
})
