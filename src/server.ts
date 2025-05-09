// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as http from 'http';
import * as onFinished from 'on-finished';
import {HandlerFunction, Request, Response} from './functions';
import {setLatestRes} from './invoker';
import {legacyPubSubEventMiddleware} from './pubsub_middleware';
import {cloudEventToBackgroundEventMiddleware} from './middleware/cloud_event_to_background_event';
import {backgroundEventToCloudEventMiddleware} from './middleware/background_event_to_cloud_event';
import {timeoutMiddleware} from './middleware/timeout';
import {wrapUserFunction} from './function_wrappers';
import {asyncLocalStorageMiddleware} from './async_local_storage';
import {executionContextMiddleware} from './execution_context';
import {FrameworkOptions} from './options';

/**
 * Creates and configures an Express application and returns an HTTP server
 * which will run it.
 * @param userFunction - User's function
 * @param options - The configured Function Framework options
 * @return HTTP server
 */
export function getServer(
  userFunction: HandlerFunction,
  options: FrameworkOptions,
): http.Server {
  // App to use for function executions.
  const app = express();

  // Express middleware

  // Set request-specific values in the very first middleware.
  app.use('/*', (req, res, next) => {
    setLatestRes(res);
    res.locals.functionExecutionFinished = false;
    next();
  });

  /**
   * Retains a reference to the raw body buffer to allow access to the raw body
   * for things like request signature validation.  This is used as the "verify"
   * function in body-parser options.
   * @param req - Express request object
   * @param res - Express response object
   * @param buf - Buffer to be saved
   */
  function rawBodySaver(req: Request, res: Response, buf: Buffer) {
    req.rawBody = buf;
  }

  // Set limit to a value larger than 32MB, which is maximum limit of higher
  // level layers anyway.
  const requestLimit = '1024mb';
  const defaultBodySavingOptions = {
    limit: requestLimit,
    verify: rawBodySaver,
  };
  const cloudEventsBodySavingOptions = {
    type: 'application/cloudevents+json',
    limit: requestLimit,
    verify: rawBodySaver,
  };
  const rawBodySavingOptions = {
    limit: requestLimit,
    verify: rawBodySaver,
    type: '*/*',
  };

  // Use extended query string parsing for URL-encoded bodies.
  const urlEncodedOptions = {
    limit: requestLimit,
    verify: rawBodySaver,
    extended: true,
  };

  // Apply middleware
  app.use(bodyParser.json(cloudEventsBodySavingOptions));
  app.use(bodyParser.json(defaultBodySavingOptions));
  app.use(bodyParser.text(defaultBodySavingOptions));
  app.use(bodyParser.urlencoded(urlEncodedOptions));
  // The parser will process ALL content types so MUST come last.
  // Subsequent parsers will be skipped when one is matched.
  app.use(bodyParser.raw(rawBodySavingOptions));
  app.enable('trust proxy'); // To respect X-Forwarded-For header.

  // Disable Express 'x-powered-by' header:
  // http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
  app.disable('x-powered-by');

  // Disable Express eTag response header
  app.set('etag', false);

  // Get execution context.
  app.use(executionContextMiddleware);
  // Store execution context to async local storge.
  app.use(asyncLocalStorageMiddleware);

  if (
    options.signatureType === 'event' ||
    options.signatureType === 'cloudevent'
  ) {
    // If a Pub/Sub subscription is configured to invoke a user's function directly, the request body
    // needs to be marshalled into the structure that wrapEventFunction expects. This unblocks local
    // development with the Pub/Sub emulator
    app.use(legacyPubSubEventMiddleware);
  }

  if (options.signatureType === 'event') {
    app.use(cloudEventToBackgroundEventMiddleware);
  }
  if (options.signatureType === 'cloudevent') {
    app.use(backgroundEventToCloudEventMiddleware);
  }
  if (options.ignoredRoutes !== null) {
    // Ignored routes is a configuration option that allows requests to specific paths to be prevented
    // from invoking the user's function. An empty string indicates that no routes should be filtered.
    if (options.ignoredRoutes.trim() !== '') {
      // Any non-empty string is the used a route expression to return 404 for.
      app.use(options.ignoredRoutes, (req, res) => {
        res.status(404).send(null);
      });
    }
  } else if (options.signatureType === 'http') {
    // We configure some default ignored routes, only for HTTP functions.
    app.use('/favicon.ico|/robots.txt', (req, res) => {
      // Neither crawlers nor browsers attempting to pull the icon find the body
      // contents particularly useful, so we filter these requests out from invoking
      // the user's function by default.
      res.status(404).send(null);
    });
  }

  if (options.signatureType === 'http') {
    app.use('/*', (req, res, next) => {
      onFinished(res, (err, res) => {
        res.locals.functionExecutionFinished = true;
      });
      next();
    });
  }

  app.use(timeoutMiddleware(options.timeoutMilliseconds));

  // Set up the routes for the user's function
  const requestHandler = wrapUserFunction(userFunction, options.signatureType);
  if (options.signatureType === 'http') {
    app.all('/*', requestHandler);
  } else {
    app.post('/*', requestHandler);
  }

  return http.createServer(app);
}
