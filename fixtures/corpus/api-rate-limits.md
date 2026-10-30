# API Rate Limits

The public API limits request rates to protect the service for everyone.

## Default limits

Free accounts may send 60 requests per minute. Pro accounts may send 600 requests per minute. Enterprise accounts have a custom limit agreed in the contract. Limits apply per API key and are measured over a sliding one minute window.

## Rate limit headers

Every response includes the headers X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset. The reset value is a Unix timestamp in seconds. When the limit is exceeded the API returns status 429 together with a Retry-After header that says how many seconds to wait.

## Handling 429 responses

Clients should retry with exponential backoff and jitter, starting at one second and doubling up to a maximum of 60 seconds. Do not retry immediately in a tight loop, because repeated violations can lead to a temporary ban of the key for 15 minutes.

## Bulk endpoints

Bulk import endpoints accept up to 1000 records per request and count as a single request toward the rate limit. Use them instead of sending many small requests.

## Requesting higher limits

Pro customers who need more capacity can request an increase through their account manager. Increases are reviewed within three business days.
