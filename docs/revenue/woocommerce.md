# WooCommerce

OpenRev records paid WooCommerce orders (any payment gateway), WooCommerce Subscriptions renewal orders and refunds, and attributes them to the visitor's traffic source.

## 1. Install the OpenRev script

Add your OpenRev snippet (Settings → Tracking code in OpenRev) to every page, for example with a header-scripts plugin or in your theme's `header.php` before `</head>`.

## 2. Save the visitor id on each order

WooCommerce webhooks include the order's meta data, so the visitor id must be stored as order meta. Add this snippet to your theme's `functions.php` (or a code-snippets plugin). It works with both the classic and the block checkout:

```php
<?php
/**
 * OpenRev: store the visitor/session ids from the tracker cookies on new orders.
 * Keys must not start with "_" (protected meta is not included in webhooks).
 */
function openrev_attach_ids( $order ) {
    foreach ( array( 'openrev_visitor_id', 'openrev_session_id' ) as $key ) {
        if ( empty( $_COOKIE[ $key ] ) ) {
            continue;
        }
        $value = sanitize_text_field( wp_unslash( $_COOKIE[ $key ] ) );
        if ( preg_match( '/^[A-Za-z0-9_-]{8,64}$/', $value ) ) {
            $order->update_meta_data( $key, $value );
        }
    }
}

// Classic checkout (the order is saved right after this hook).
add_action( 'woocommerce_checkout_create_order', function ( $order ) {
    openrev_attach_ids( $order );
} );

// Block checkout (Store API).
add_action( 'woocommerce_store_api_checkout_update_order_meta', function ( $order ) {
    openrev_attach_ids( $order );
    $order->save();
} );
```

### Alternative without PHP

If you cannot add PHP, add this to your thank-you page (WooCommerce's “order received” page has `?key=wc_order_…` in its URL). It reports the order key, which OpenRev matches with the order:

```html
<script>
  (function () {
    var key = new URLSearchParams(location.search).get("key");
    if (key && /^wc_order_/.test(key) && /order-received/.test(location.href)) window.openrev && window.openrev("payment", { ref: key });
  })();
</script>
```

## 3. Connect WooCommerce in OpenRev

1. Choose a webhook secret (a long random string, e.g. `openssl rand -hex 24`).
2. In OpenRev open **Settings → Revenue → Connect → WooCommerce** and paste it as **Webhook secret**.
3. Copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 4. Create the webhooks in WooCommerce

In WordPress go to **WooCommerce → Settings → Advanced → Webhooks → Add webhook** and create **two** webhooks with the same URL and secret:

| Name | Topic | Used for |
| --- | --- | --- |
| OpenRev orders created | **Order created** (`order.created`) | Orders paid immediately |
| OpenRev orders updated | **Order updated** (`order.updated`) | Orders that become paid later, renewals and refunds |

For both: Status **Active**, Delivery URL = the OpenRev webhook URL, Secret = the same secret as in OpenRev, API version **WP REST API Integration v3**.

When you save, WooCommerce sends an unsigned `webhook_id=…` ping to check the URL; OpenRev answers it with 200 so the webhook is activated. Because the ping isn't signed, it doesn't clear an error shown on the integration.

## How payments are counted

- An order counts as paid when its status is `processing` or `completed` (configurable with **Paid order statuses**, e.g. `processing,completed,on-hold`). The order id is the transaction id, so the many `order.updated` deliveries of one order are recorded once.
- Amount: the order `total` (major units such as `"29.35"`, including tax and shipping) in the order currency, converted to your site currency.
- Renewal orders created by WooCommerce Subscriptions (`created_via: subscription`) are **renewals** and inherit the attribution of the customer's first order.
- Refunds are read from the order's `refunds` list (or the full total when the status is `refunded`). The refunded amount is cumulative, so partial refunds are handled.

## Troubleshooting

- **Webhook disabled by WooCommerce**: WooCommerce disables a webhook after repeated failed deliveries. Fix the secret in OpenRev, then set the webhook back to **Active**.
- **Orders without a source**: check that the order shows `openrev_visitor_id` under **Custom fields** in the order screen. If it is missing, the snippet is not running or the tracker cookie is not set (e.g. cookieless mode).
