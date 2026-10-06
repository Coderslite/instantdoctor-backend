import { eq } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client.js';
import { productCategories } from '../src/db/schema/index.js';
import { newId } from '../src/lib/ids.js';

const categories = [
  'Analgesics & Pain Relief',
  'Anaesthetics',
  'Antacids & Acid Reflux',
  'Antibiotics',
  'Antifungals',
  'Antivirals',
  'Allergy & Antihistamines',
  'Arthritis & Joint Care',
  'Asthma & Respiratory Care',
  'Blood Pressure Medicines',
  'Blood Thinners & Anticoagulants',
  'Cardiovascular Medicines',
  'Cholesterol Medicines',
  'Cold, Cough & Flu',
  'Diabetes Care',
  'Digestive Health',
  'Diuretics',
  'Ear Care',
  'Emergency Medicines',
  'Endocrine & Hormonal Medicines',
  'Eye Care',
  'Gastrointestinal Medicines',
  'Gout Medicines',
  'HIV & Antiretroviral Medicines',
  'Immune System Medicines',
  'Kidney & Urinary Care',
  'Liver Care',
  'Malaria Medicines',
  'Mental Health Medicines',
  'Migraine Medicines',
  'Muscle Relaxants',
  'Neurology & Epilepsy Medicines',
  'Oncology Medicines',
  'Oral & Dental Care',
  'Sexual Health',
  'Skin Care & Dermatology',
  'Sleep & Anxiety Relief',
  'Steroids & Anti-inflammatory Medicines',
  'Thyroid Medicines',
  'Tuberculosis Medicines',
  'Women’s Health',
  'Men’s Health',
  'Fertility & Reproductive Health',
  'Contraceptives',
  'Pregnancy & Maternity Care',
  'Baby & Child Health',
  'Paediatric Medicines',
  'Vitamins & Supplements',
  'Herbal & Natural Remedies',
  'Sports Nutrition',
  'Weight Management',
  'First Aid',
  'Wound Care',
  'Medical Devices',
  'Diagnostic & Test Kits',
  'Mobility & Rehabilitation',
  'Compression & Support',
  'Home Healthcare',
  'Incontinence Care',
  'Personal Care & Hygiene',
  'Feminine Hygiene',
  'Hair Care',
  'Foot Care',
  'Sun Care',
  'Protective Equipment',
  'Vaccines & Immunisation',
  'Prescription Medicines',
  'Over-the-Counter Medicines',
];

let created = 0;
for (const name of categories) {
  const [existing] = await db.select({ id: productCategories.id }).from(productCategories).where(eq(productCategories.name, name)).limit(1);
  if (!existing) {
    await db.insert(productCategories).values({ id: newId(), name });
    created += 1;
  }
}

process.stdout.write(`Pharmacy categories ready: ${categories.length} total, ${created} created.\n`);
await closeDatabase();
