import got, { mergeOptions } from 'got'
import { globalTracer, Tags, Span, SpanOptions, Tracer, FORMAT_HTTP_HEADERS } from 'opentracing'
import CacheableLookup from 'cacheable-lookup'
import HttpAgent, { HttpsAgent, HttpOptions, HttpsOptions } from 'agentkeepalive'
import pkg from '../package.json'

interface Options {
  tracingOptions?: TracingOptions
  [key: string]: any
}

interface TracingOptions {
  tracer?: Tracer
  span?: Span
  parentSpan: Span
  closeParentSpan?: boolean
  injectHeaders?: boolean
}

/**
 * Logs information about timing events related to a client http request to the given span
 */
const logTimings = (span: Span, timings: any) => {
  // We only want to log if we have a span, and if the timing object has keys
  if (span && timings && Object.keys(timings).length > 0) {
    // The name of the events might not be easy to understand what means, so we add descriptions
    // and we also want to log the duration without spamming with new log lines, so we say which phase
    // to log after each event
    const events = {
      start: { description: 'Request started.', phase: null },
      socket: { description: 'Socket was assigned to the request.', phase: 'wait' },
      lookup: { description: 'DNS lookup finished.', phase: 'dns' },
      connect: { description: 'Socket successfully connected.', phase: 'tcp' },
      upload: { description: 'Request finished uploading.', phase: 'request' },
      response: { description: 'Request fired the response event.', phase: 'firstByte' },
      end: { description: 'Response fired the end event.', phase: 'download' },
      error: { description: 'Request fired the error event.', phase: 'total' },
    }

    Object.keys(timings).forEach(key => {
      // We want to log for each timing event, and not the durations, which lie in the `phases` key
      if (key !== 'phases') {
        if (timings[key]) {
          span.log(
            {
              event: key,
              description: events[key].description,
              // Add extra field for the duration of the phase, looke like: `phase="total dns 4ms"`
              [`total ${events[key].phase || 'start'}`]: `${timings.phases[events[key].phase] || 0}ms`,
            },
            timings[key],
          )
        }
      }
    })
  }
}

/**
 * Logs information about an error to the given span in opentracing
 * This function does NOT finish the span, so make sure to call `span.finish()` after using this
 */
export const logError = (span: Span, error: any) => {
  const { stack, message, name, statusCode } = error
  span.setTag(Tags.ERROR, true)
  // Since this is an error, we want to prioritize sending this trace (in cases where you only sameple X% of traces)
  span.setTag(Tags.SAMPLING_PRIORITY, 1)

  // If we got the status code from got, we set the tag
  if (statusCode) {
    span.setTag(Tags.HTTP_STATUS_CODE, statusCode)
  }

  // Log information about the error to the span
  // Following the semantic conventions of opentracing (https://github.com/opentracing/specification/blob/master/semantic_conventions.md#log-fields-table)
  // but since the error object is pretty custom in this case, we do not set `error.object` in fear of circular json
  span.log({
    event: 'error',
    message,
    stack: stack,
    'error.kind': name,
  })
}

// Create a cache for DNS lookups
const cacheable: CacheableLookup = new CacheableLookup()

/**
 * Wraps a got call in an opentracing span, custom options defined as an interface.
 * The rest of the possible options can be found in the got documentation: https://github.com/sindresorhus/got
 */
const otGot = (url: string, opts: Options = {}) => {
  // Create custom http agents for small performance boost
  // Read more at: https://github.com/node-modules/agentkeepalive
  const agentOpts: HttpOptions | HttpsOptions = opts.agentOpts || {
    maxSockets: 200,
    maxFreeSockets: 20,
    freeSocketTimeout: 30000,
  }

  const httpAgent: HttpAgent = new HttpAgent(agentOpts)
  const httpsAgent: HttpsAgent = new HttpsAgent(agentOpts)

  // We use a passed in tracer, and if none is passed in we get the global tracer
  const tracer =
    opts.tracingOptions && opts.tracingOptions.tracer ? opts.tracingOptions.tracer : globalTracer()

  // Set a parent span, e.g. if you start your trace in your server router
  // we want this client request to be a child of that
  const parentSpan =
    opts.tracingOptions && opts.tracingOptions.parentSpan ? opts.tracingOptions.parentSpan : null

  const injectHeaders =
    opts.tracingOptions && opts.tracingOptions.injectHeaders ? opts.tracingOptions.injectHeaders : false

  // Add our custom option
  const otOptions: Options = {
    agent: {
      http: httpAgent,
      https: httpsAgent,
    },
    tracingOptions: {
      tracer,
      parentSpan,
      injectHeaders,
    },
    headers: {
      ...opts.headers,
    },
    // Use the dns cache we created earlier
    lookup: cacheable.lookup,
    hooks: {
      // If we have to retry the requests, we should log it so we can see potential issues
      // ¯\_(ツ)_/¯ not sure if we should tag the span as en error at this point
      // The request might succeed, but there might still be an issue in the stack
      beforeRetry: [
        (options: Options, error: any, retryCount: number) => {
          options.tracingOptions.span.log({
            ['http.retry_count']: retryCount,
            error: error.message,
            [`http.status_code`]: error.statusCode,
          })
        },
      ],
    },
  }

  if (tracer) {
    const { method = 'GET', body } = opts

    const spanOptions: SpanOptions = {
      childOf: parentSpan,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
        [Tags.HTTP_URL]: url,
        [Tags.HTTP_METHOD]: method,
        [Tags.COMPONENT]: `${pkg.name} v${pkg.version}`,
      },
    }
    // Create a new span which looks like this: `HTTP POST`
    const span: Span = tracer.startSpan(`HTTP ${method}`, spanOptions)
    // Log the request body
    span.log({
      body,
    })
    // Set the span so we can use it in other hooks and in the request itself
    otOptions.tracingOptions.span = span
    // Inject http headers so the recieving endpoint can continue the trace
    if (injectHeaders) {
      tracer.inject(span, FORMAT_HTTP_HEADERS, otOptions.headers)
    }
  }

  // Merge the options passed in with our own custom options
  opts = mergeOptions(opts, otOptions)

  // Return the got instance
  return got(url, opts)
    .then(res => {
      // Get the timings and log them to the span
      const { timings } = res
      logTimings(opts.tracingOptions.span, timings)

      // In most cases you do not want to close the span here because you do it yourself
      // E.g. if the parent span comes from your express handler, you are probably closing the span yourself on `res.on('close')`
      // But if you want it to be closed when the request is done, let's allow that.
      if (opts.tracingOptions.closeParentSpan) {
        opts.tracingOptions.parentSpan.finish()
      }
      opts.tracingOptions.span.finish()
      return res
    })
    .catch(err => {
      // Thanks to got, we get the response in the error, let's log the timings if we have them
      if (err.response && err.response.timings) {
        logTimings(opts.tracingOptions.span, err.response.timings)
      }

      logError(opts.tracingOptions.span, err)

      // In most cases you do not want to close the span here because you do it yourself
      // E.g. if the parent span comes from your express handler, you are probably closing the span yourself on `res.on('close')`
      // But if you want it to be closed when the request is done, let's allow that.
      if (opts.tracingOptions.closeParentSpan) {
        opts.tracingOptions.parentSpan.finish()
      }
      opts.tracingOptions.span.finish()
      throw err
    })
}

export default otGot
