import { ApolloLink, Observable } from 'apollo-link'
import {
  selectURI,
  selectHttpOptionsAndBody,
  fallbackHttpConfig,
  serializeFetchParameter,
  createSignalIfSupported,
  parseAndCheckHttpResponse
} from 'apollo-link-http-common'
import {
  extractFilesOrStreams,
  isStream,
  isBrowserOrNative,
  NoFormDataException
} from './extract-streams-files'
export { ReactNativeFile } from 'extract-files'
export const createUploadLink = ({
  uri: fetchUri = '/graphql',
  fetch: linkFetch = fetch,
  fetchOptions,
  credentials,
  headers,
  includeExtensions,
  serverFormData
} = {}) => {
  const linkConfig = {
    http: {
      includeExtensions
    },
    options: fetchOptions,
    credentials,
    headers
  }
  return new ApolloLink(operation => {
    const uri = selectURI(operation, fetchUri)
    const context = operation.getContext()
    const contextConfig = {
      http: context.http,
      options: context.fetchOptions,
      credentials: context.credentials,
      headers: context.headers
    }
    const { options, body } = selectHttpOptionsAndBody(
      operation,
      fallbackHttpConfig,
      linkConfig,
      contextConfig
    )
    const files = extractFilesOrStreams(body)
    const payload = serializeFetchParameter(body, 'Payload')
    const promises = []

    if (files.length) {
      delete options.headers['content-type']
      if (isBrowserOrNative) options.body = new FormData()
      else if (serverFormData) options.body = new serverFormData()
      else
        throw new NoFormDataException(`FormData function doesn't exist on this server version. \
We suggest you installing 'form-data' via npm and pass it as \
as an argument in 'createUploadLink' function : '{ serverFormData: FormData }'`)
      options.body.append('operations', payload)
      options.body.append(
        'map',
        JSON.stringify(
          files.reduce((map, { path }, index) => {
            map[`${index}`] = [path]
            return map
          }, {})
        )
      )
      files.forEach(({ file }, index) => {
        if (isStream(file)) options.body.append(index, file)
        else if (file instanceof Promise)
          promises.push(
            new Promise((resolve, reject) => {
              file
                .then(file => {
                  const { filename, mimetype: contentType } = file
                  const bufs = []
                  const fileStream = file.createReadStream()
                  fileStream.on('data', function(buf) {
                    bufs.push(buf)
                  })
                  fileStream.on('end', function() {
                    const buffer = Buffer.concat(bufs)
                    const knownLength = buffer.byteLength
                    options.body.append(index, buffer, {
                      filename: filename,
                      contentType,
                      knownLength
                    })
                    resolve()
                  })
                  fileStream.on('error', reject)
                })
                .catch(reject)
            })
          )
        else options.body.append(index, file, file.name)
      })
    } else options.body = payload

    return new Observable(observer => {
      const { controller, signal } = createSignalIfSupported()
      if (controller) options.signal = signal
      Promise.all(promises)
        .then(() => {
          linkFetch(uri, options)
            .then(response => {
              operation.setContext({
                response
              })
              return response
            })
            .then(parseAndCheckHttpResponse(operation))
            .then(result => {
              observer.next(result)
              observer.complete()
            })
            .catch(error => {
              if (error.name === 'AbortError') return
              if (error.result && error.result.errors && error.result.data)
                observer.next(error.result)
              observer.error(error)
            })
        })
        .catch(e => {
          throw {
            message: 'Error while draining stream.',
            error: e
          }
        })
      return () => {
        if (controller) controller.abort()
      }
    })
  })
}
