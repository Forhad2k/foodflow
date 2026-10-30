/**
 * Local-development seed. Refuses to run in production.
 * Idempotent: safe to run repeatedly.
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD come from the environment: no password is hard-coded here.
 */
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/common/utils/password';
import { DEFAULT_SETTINGS } from '../src/settings/settings.defaults';

const prisma = new PrismaClient();

const CUISINES = ['Bangladeshi', 'Biryani', 'Burgers', 'Chinese', 'Pizza', 'Fast Food', 'Desserts', 'Healthy', 'Kebab & Grill', 'Beverages'];

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed in production');

  for (const name of CUISINES) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    await prisma.cuisineType.upsert({ where: { slug }, update: {}, create: { name, slug } });
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.platformSetting.upsert({ where: { key }, update: {}, create: { key, value: value as never } });
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@foodflow.local').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 10) {
    console.warn('SEED_ADMIN_PASSWORD not set (min 10 chars): skipping admin creation.');
  } else {
    const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (!existing) {
      await prisma.user.create({
        data: {
          email: adminEmail,
          role: Role.ADMIN,
          emailVerifiedAt: new Date(),
          credential: { create: { passwordHash: await hashPassword(adminPassword) } },
          profile: { create: { fullName: 'Platform Admin' } },
        },
      });
      console.log(`Created admin ${adminEmail}`);
    }
  }
  await seedDemoData();
  console.log('Seed complete.');
}

/**
 * Demo restaurants around Gulshan/Banani/Dhanmondi (Dhaka) so discovery has something to find.
 * Needs SEED_DEMO_PASSWORD (min 10 chars) for the demo owner/customer accounts; skipped otherwise.
 * Open daily 10:00-23:00 Asia/Dhaka, delivering within 4 km. No images: the UI falls back to placeholders.
 */
async function seedDemoData() {
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 10) {
    console.warn('SEED_DEMO_PASSWORD not set (min 10 chars): skipping demo restaurants/customer.');
    return;
  }
  const passwordHash = await hashPassword(password);

  const ensureUser = async (email: string, role: Role, fullName: string, phone?: string) =>
    (await prisma.user.findUnique({ where: { email } })) ??
    prisma.user.create({
      data: { email, role, phone, emailVerifiedAt: new Date(), credential: { create: { passwordHash } }, profile: { create: { fullName } } },
    });

  const owner = await ensureUser('owner@foodflow.local', Role.RESTAURANT_OWNER, 'Demo Owner');
  await ensureUser('customer@foodflow.local', Role.CUSTOMER, 'Demo Customer', '+8801700000001');

  const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, opensAtMin: 600, closesAtMin: 1380 }));
  const cuisine = (slug: string) => prisma.cuisineType.findUniqueOrThrow({ where: { slug } });

  type DemoItem = { name: string; price: number; stock?: number; variants?: [string, number][]; addons?: { name: string; min: number; max: number; options: [string, number][] } };
  const demo: { slug: string; name: string; cuisine: string; lat: number; lng: number; address: string; tier: number; fee: number; menu: { category: string; items: DemoItem[] }[] }[] = [
    { slug: 'kacchi-bhai-gulshan', name: 'Kacchi Bhai', cuisine: 'biryani', lat: 23.7937, lng: 90.4066, address: 'Gulshan 2', tier: 2, fee: 4000,
      menu: [{ category: 'Biryani', items: [
        { name: 'Kacchi Biryani', price: 32000, variants: [['Half', 32000], ['Full', 59000]], addons: { name: 'Sides', min: 0, max: 2, options: [['Borhani', 4000], ['Salad', 2000]] } },
        { name: 'Chicken Roast', price: 12000 },
      ] }] },
    { slug: 'pizza-hub-banani', name: 'Pizza Hub', cuisine: 'pizza', lat: 23.7940, lng: 90.4030, address: 'Banani 11', tier: 3, fee: 6000,
      menu: [{ category: 'Pizza', items: [
        { name: 'Margherita', price: 55000, variants: [['Medium', 55000], ['Large', 82000]], addons: { name: 'Extra toppings', min: 0, max: 3, options: [['Cheese', 8000], ['Mushroom', 6000], ['Olives', 5000]] } },
      ] }] },
    { slug: 'burger-lab-dhanmondi', name: 'Burger Lab', cuisine: 'burgers', lat: 23.7461, lng: 90.3742, address: 'Dhanmondi 27', tier: 2, fee: 5000,
      menu: [{ category: 'Burgers', items: [
        { name: 'Classic Beef Burger', price: 38000, stock: 25 },
        { name: 'Fries', price: 15000 },
      ] }] },
  ];

  for (const d of demo) {
    if (await prisma.restaurant.findUnique({ where: { slug: d.slug } })) continue;
    const c = await cuisine(d.cuisine);
    const restaurant = await prisma.restaurant.create({
      data: {
        ownerId: owner.id, name: d.name, slug: d.slug, description: `${d.name}: demo restaurant`, phone: '+8801700000002',
        addressLine: d.address, city: 'Dhaka', lat: d.lat, lng: d.lng, approvalStatus: 'APPROVED', priceTier: d.tier,
        baseDeliveryFeeMinor: d.fee, minOrderMinor: 20000, avgPrepMinutes: 20,
        cuisines: { create: [{ cuisineId: c.id }] },
        zones: { create: [{ name: 'Local delivery', type: 'RADIUS', radiusMeters: 4000 }] },
        hours: { create: hours },
      },
    });
    for (const [ci, cat] of d.menu.entries()) {
      const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: cat.category, sortOrder: ci } });
      for (const [ii, it] of cat.items.entries()) {
        await prisma.menuItem.create({
          data: {
            restaurantId: restaurant.id, categoryId: category.id, name: it.name, basePriceMinor: it.price, sortOrder: ii,
            stockQuantity: it.stock ?? null,
            ...(it.variants && { variants: { create: it.variants.map(([name, priceMinor], vi) => ({ name, priceMinor, isDefault: vi === 0 })) } }),
            ...(it.addons && {
              addonGroups: { create: [{ name: it.addons.name, minSelect: it.addons.min, maxSelect: it.addons.max, addons: { create: it.addons.options.map(([name, priceMinor]) => ({ name, priceMinor })) } }] },
            }),
          },
        });
      }
    }
  }

  await prisma.coupon.upsert({
    where: { code: 'WELCOME50' },
    update: {},
    create: {
      code: 'WELCOME50', type: 'FIXED_AMOUNT', value: 5000, minSubtotalMinor: 30000, firstOrderOnly: true,
      startsAt: new Date(), endsAt: new Date(Date.now() + 365 * 86_400_000), usageLimitPerUser: 1,
    },
  });
  console.log('Seeded demo restaurants, demo customer/owner and coupon WELCOME50.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
