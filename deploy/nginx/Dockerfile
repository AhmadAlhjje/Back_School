# Edge server (build context: this folder): TLS, the API reverse proxy, authorized media through
# X-Accel-Redirect, and the two dashboards as static sites mounted from ../sites/owner and ../sites/admin.
ARG NGINX_IMAGE=nginx:1.28-alpine
FROM ${NGINX_IMAGE}
RUN apk add --no-cache openssl \
 && rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /var/www/certbot /usr/share/nginx/owner /usr/share/nginx/admin
COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets /etc/nginx/snippets
# Rendered at container start by the image's envsubst step (only ${...} of defined variables).
COPY templates /etc/nginx/templates
COPY reload-on-renewal.sh /docker-entrypoint.d/90-reload-on-renewal.sh
RUN chmod +x /docker-entrypoint.d/90-reload-on-renewal.sh
EXPOSE 80 443
