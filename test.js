import test, { after } from 'ava'
import nock from 'nock'
import { MockTracer, initGlobalTracer } from 'opentracing'
import sinon from 'sinon'
import otGot from './dist/src/index'

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

  t.is(tracer._spans.length, 2)

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

  t.is(tracer._spans[1]._logs[0].fields.body, undefined)
  t.is(tracer._spans[1]._logs[1].fields.event, 'start')
  t.is(tracer._spans[1]._logs[2].fields.event, 'socket')
  t.is(tracer._spans[1]._logs[3].fields.event, 'lookup')
  t.is(tracer._spans[1]._logs[4].fields.event, 'connect')
  t.is(tracer._spans[1]._logs[5].fields.event, 'upload')
  t.is(tracer._spans[1]._logs[6].fields.event, 'response')
  t.is(tracer._spans[1]._logs[7].fields.event, 'end')

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

  t.is(tracer._spans[1]._logs[0].fields.body, 'This is a body.')

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

  let retries = 0
  tracer._spans[1]._logs.forEach(log => {
    Object.keys(log.fields).forEach(key => {
      if (key === 'http.retry_count') retries += 1
    })
  })
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

  t.is(tracer._spans[0]._finishMs, 0)

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

  t.not(tracer._spans[0]._finishMs, 0)

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

  t.not(tracer._spans[0]._finishMs, 0)

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
