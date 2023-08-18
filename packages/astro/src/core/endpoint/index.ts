import type {
	APIContext,
	EndpointHandler,
	EndpointOutput,
	MiddlewareEndpointHandler,
	MiddlewareHandler,
	Params,
} from '../../@types/astro';
import mime from 'mime';
import type { Environment, RenderContext } from '../render/index';
import { renderEndpoint } from '../../runtime/server/index.js';
import { ASTRO_VERSION } from '../constants.js';
import { AstroCookies, attachCookiesToResponse } from '../cookies/index.js';
import { AstroError, AstroErrorData } from '../errors/index.js';
import { warn } from '../logger/core.js';
import { callMiddleware } from '../middleware/callMiddleware.js';

const encoder = new TextEncoder();

const clientAddressSymbol = Symbol.for('astro.clientAddress');
const clientLocalsSymbol = Symbol.for('astro.locals');

type CreateAPIContext = {
	request: Request;
	params: Params;
	site?: string;
	props: Record<string, any>;
	adapterName?: string;
};

/**
 * Creates a context that holds all the information needed to handle an Astro endpoint.
 *
 * @param {CreateAPIContext} payload
 */
export function createAPIContext({
	request,
	params,
	site,
	props,
	adapterName,
}: CreateAPIContext): APIContext {
	const context = {
		cookies: new AstroCookies(request),
		request,
		params,
		site: site ? new URL(site) : undefined,
		generator: `Astro v${ASTRO_VERSION}`,
		props,
		redirect(path, status) {
			return new Response(null, {
				status: status || 302,
				headers: {
					Location: path,
				},
			});
		},
		ResponseWithEncoding,
		url: new URL(request.url),
		get clientAddress() {
			if (!(clientAddressSymbol in request)) {
				if (adapterName) {
					throw new AstroError({
						...AstroErrorData.ClientAddressNotAvailable,
						message: AstroErrorData.ClientAddressNotAvailable.message(adapterName),
					});
				} else {
					throw new AstroError(AstroErrorData.StaticClientAddressNotAvailable);
				}
			}

			return Reflect.get(request, clientAddressSymbol);
		},
	} as APIContext;

	// We define a custom property, so we can check the value passed to locals
	Object.defineProperty(context, 'locals', {
		enumerable: true,
		get() {
			return Reflect.get(request, clientLocalsSymbol);
		},
		set(val) {
			if (typeof val !== 'object') {
				throw new AstroError(AstroErrorData.LocalsNotAnObject);
			} else {
				Reflect.set(request, clientLocalsSymbol, val);
			}
		},
	});
	return context;
}

type ResponseParameters = ConstructorParameters<typeof Response>;

export class ResponseWithEncoding extends Response {
	constructor(body: ResponseParameters[0], init: ResponseParameters[1], encoding: BufferEncoding) {
		super(body, init);
		this.headers.set('X-Astro-Encoding', encoding);
	}
}

export async function callEndpoint<MiddlewareResult = Response | EndpointOutput>(
	mod: EndpointHandler,
	env: Environment,
	ctx: RenderContext,
	onRequest?: MiddlewareHandler<MiddlewareResult> | undefined
): Promise<Response> {
	const context = createAPIContext({
		request: ctx.request,
		params: ctx.params,
		props: ctx.props,
		site: env.site,
		adapterName: env.adapterName,
	});

	let response;
	if (onRequest) {
		response = await callMiddleware<Response | EndpointOutput>(
			env.logging,
			onRequest as MiddlewareEndpointHandler,
			context,
			async () => {
				return await renderEndpoint(mod, context, env.ssr, env.logging);
			}
		);
	} else {
		response = await renderEndpoint(mod, context, env.ssr, env.logging);
	}

	const isEndpointSSR = env.ssr && !ctx.route?.prerender;

	if (response instanceof Response) {
		if (isEndpointSSR && response.headers.get('X-Astro-Encoding')) {
			warn(
				env.logging,
				'ssr',
				'`ResponseWithEncoding` is ignored in SSR. Please return an instance of Response. See https://docs.astro.build/en/core-concepts/endpoints/#server-endpoints-api-routes for more information.'
			);
		}
		attachCookiesToResponse(response, context.cookies);
		return response;
	}

	// The endpoint returned a simple object, convert it to a Response

	// TODO: Remove in Astro 4.0
	warn(
		env.logging,
		'astro',
		`${ctx.route.route} returns a simple object which is deprecated. Please return an instance of Response. See https://docs.astro.build/en/core-concepts/endpoints/#server-endpoints-api-routes for more information.`
	);

	if (isEndpointSSR) {
		if (response.hasOwnProperty('headers')) {
			warn(
				env.logging,
				'ssr',
				'Setting headers is not supported when returning an object. Please return an instance of Response. See https://docs.astro.build/en/core-concepts/endpoints/#server-endpoints-api-routes for more information.'
			);
		}

		if (response.encoding) {
			warn(
				env.logging,
				'ssr',
				'`encoding` is ignored in SSR. To return a charset other than UTF-8, please return an instance of Response. See https://docs.astro.build/en/core-concepts/endpoints/#server-endpoints-api-routes for more information.'
			);
		}
	}

	let body: BodyInit;
	const headers = new Headers();

	const mimeType = mime.getType(ctx.route.route) || 'text/plain';
	headers.set('Content-Type', `${mimeType};charset=utf-8`);

	// Save encoding to X-Astro-Encoding to be used later during SSG with `fs.writeFile`.
	// It won't work in SSR and is already warned above.
	if (response.encoding) {
		headers.set('X-Astro-Encoding', response.encoding);
	}

	// For binary string or UInt8Array, it can passed to Response directly
	if (response.body instanceof Uint8Array) {
		body = response.body;
		headers.set('Content-Length', body.byteLength.toString());
	}
	// In NodeJS, we can use Buffer.from which supports all BufferEncoding
	else if (typeof Buffer !== 'undefined' && Buffer.from) {
		body = Buffer.from(response.body, response.encoding);
		headers.set('Content-Length', body.byteLength.toString());
	}
	// In non-NodeJS, use the web-standard TextEncoder for utf-8 strings only
	// to calculate the content length
	else if (
		response.encoding == null ||
		response.encoding === 'utf8' ||
		response.encoding === 'utf-8'
	) {
		body = encoder.encode(response.body);
		headers.set('Content-Length', body.byteLength.toString());
	}
	// Fallback pass it to Response directly. It will mainly rely on X-Astro-Encoding
	// to be further processed in SSG.
	else {
		body = response.body;
		// NOTE: Can't calculate the content length as we can't encode to figure out the real length.
		// But also because we don't need the length for SSG as it's only being written to disk.
	}

	response = new Response(body, {
		status: 200,
		headers,
	});
	attachCookiesToResponse(response, context.cookies);
	return response;
}
