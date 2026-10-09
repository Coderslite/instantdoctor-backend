import { eq, sql } from 'drizzle-orm';
import { closeDatabase, databaseLabel, db } from '../src/db/client.js';
import { healthTipCategories } from '../src/db/schema/index.js';
import { newId } from '../src/lib/ids.js';

const categories = [
  {
    name: 'Healthy Habits',
    slug: 'healthy-habits',
    description: 'Everyday habits that support better physical and mental wellbeing.',
    image: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Healthy Habits and Everyday Wellness',
    metaDescription: 'Practical, doctor-reviewed guidance for building healthy routines and feeling your best.',
  },
  {
    name: 'Chronic Disease Care',
    slug: 'chronic-disease-care',
    description: 'Reliable guidance for understanding and managing long-term health conditions.',
    image: 'https://images.unsplash.com/photo-1505751172876-fa1923c5c528?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Chronic Disease Care and Management',
    metaDescription: 'Learn about ongoing condition management, monitoring, treatment and when to seek care.',
  },
  {
    name: 'Heart & Circulation',
    slug: 'heart-circulation',
    description: 'Information on heart health, blood pressure and healthy circulation.',
    image: 'https://images.unsplash.com/photo-1559757175-0eb30cd8c063?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Heart Health and Circulation',
    metaDescription: 'Doctor-reviewed information about heart health, circulation and cardiovascular risk.',
  },
  {
    name: 'Seasonal Health',
    slug: 'seasonal-health',
    description: 'Health advice for changing weather, seasonal illnesses and environmental risks.',
    image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Seasonal Health Advice',
    metaDescription: 'Stay well through changing seasons with practical prevention and symptom-care advice.',
  },
  {
    name: 'Child & Family Health',
    slug: 'child-family-health',
    description: 'Helpful health information for children, parents and families at every stage.',
    image: 'https://images.unsplash.com/photo-1511895426328-dc8714191300?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Child and Family Health',
    metaDescription: 'Evidence-based health guidance for children, parents and the whole family.',
  },
  {
    name: 'Sleep & Rest',
    slug: 'sleep-rest',
    description: 'Understand sleep, build restful routines and learn when sleep problems need care.',
    image: 'https://images.unsplash.com/photo-1541781774459-bb2af2f05b55?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Sleep, Rest and Recovery',
    metaDescription: 'Explore practical ways to improve sleep, support recovery and address common sleep concerns.',
  },
  {
    name: 'Fitness & Exercise',
    slug: 'fitness-exercise',
    description: 'Safe, sustainable ways to move more and make physical activity part of daily life.',
    image: 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Fitness and Exercise for Better Health',
    metaDescription: 'Find realistic exercise advice for building strength, improving fitness and staying active.',
  },
  {
    name: 'Nutrition & Diet',
    slug: 'nutrition-diet',
    description: 'Clear, balanced guidance on food, nutrition and healthy eating.',
    image: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=1200&q=80',
    metaTitle: 'Nutrition and Healthy Eating',
    metaDescription: 'Learn about balanced nutrition, healthy eating habits and making informed food choices.',
  },
] as const;

let created = 0;
let updated = 0;

try {
  console.log(`Database: ${databaseLabel}`);
  for (const [index, category] of categories.entries()) {
    const [bySlug] = await db
      .select({ id: healthTipCategories.id })
      .from(healthTipCategories)
      .where(eq(healthTipCategories.slug, category.slug))
      .limit(1);
    const [byName] = await db
      .select({ id: healthTipCategories.id })
      .from(healthTipCategories)
      .where(sql`lower(${healthTipCategories.name}) = lower(${category.name})`)
      .limit(1);

    if (bySlug && byName && bySlug.id !== byName.id) {
      throw new Error(`Category slug and name point to different rows: ${category.slug}`);
    }

    const existing = bySlug ?? byName;
    if (existing) {
      await db
        .update(healthTipCategories)
        .set({ ...category, sortOrder: index + 1 })
        .where(eq(healthTipCategories.id, existing.id));
      updated += 1;
    } else {
      await db.insert(healthTipCategories).values({
        id: newId(),
        ...category,
        sortOrder: index + 1,
      });
      created += 1;
    }
  }

  console.log(`Blog categories ready: ${categories.length} seeded, ${created} created, ${updated} updated.`);
} finally {
  await closeDatabase();
}
