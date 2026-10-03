import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as schemas from './pharmacy.schemas.js';
import * as service from './pharmacy.service.js';

export const pharmacyRouter = Router();
// Mounted at the API root, so scope auth to this router's own prefixes.
pharmacyRouter.use(['/pharmacies', '/products', '/orders'], authenticate);

pharmacyRouter.get('/pharmacies', async (req, res) => {
  res.json({ items: await service.listPharmacies(parse(schemas.nearbyQuery, req.query)) });
});

pharmacyRouter.get('/pharmacies/:id', async (req, res) => {
  res.json(await service.getPharmacy(req.params.id));
});

pharmacyRouter.get('/pharmacies/:id/products', async (req, res) => {
  res.json({ items: await service.listPharmacyProducts(req.params.id) });
});

pharmacyRouter.get('/products/categories', async (_req, res) => {
  res.json({ items: await service.listProductCategories() });
});

pharmacyRouter.get('/products/:id', async (req, res) => {
  res.json(await service.getProduct(req.params.id));
});

/** Price a cart (delivery fees, surcharge) without creating anything. */
pharmacyRouter.post('/orders/quote', async (req, res) => {
  res.json(await service.quoteCart(parse(schemas.cartSchema, req.body)));
});

/** Create a checkout awaiting payment. Requires an `Idempotency-Key` header. */
pharmacyRouter.post('/orders/checkout', idempotent('orders.checkout'), async (req, res) => {
  const input = parse(schemas.checkoutSchema, req.body);
  const { checkout, created } = await service.createCheckout(currentUser(req).userId, input, req.idempotencyKey);
  res.status(created ? 201 : 200).json(checkout);
});

pharmacyRouter.get('/orders', async (req, res) => {
  const query = parse(schemas.listOrdersQuery, req.query);
  res.json({ items: await service.listOrders(currentUser(req).userId, query), limit: query.limit, offset: query.offset });
});

pharmacyRouter.get('/orders/:id', async (req, res) => {
  res.json(await service.getOrder(currentUser(req).userId, req.params.id));
});
