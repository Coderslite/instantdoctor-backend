/**
 * Starter articles for the Instant Doctor blog. Bodies are clean, style-free HTML so they take
 * the website's typography. Images are placeholder photos (picsum.photos) — replace them with
 * real artwork in the admin. Every article should be checked by a clinician before launch.
 */

export type SeedPost = {
  slug: string;
  title: string;
  excerpt: string;
  categorySlug: string;
  tags: string[];
  featured?: boolean;
  /** Days before the seed run that the post is dated. */
  daysAgo: number;
  image: string;
  imageAlt: string;
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  body: string;
};

const img = (seed: string, w = 1200, h = 675) => `https://picsum.photos/seed/${seed}/${w}/${h}`;
const ext = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const post = (slug: string, text: string) => `<a href="/blog/${slug}">${text}</a>`;
const figure = (seed: string, alt: string, caption: string) =>
  `<figure><img src="${img(seed, 1000, 600)}" alt="${alt}" width="1000" height="600" loading="lazy"><figcaption>${caption}</figcaption></figure>`;

export const posts: SeedPost[] = [
  {
    slug: 'healthy-screen-habits-20-20-20-rule',
    title: 'Healthy Screen Habits: How the 20-20-20 Rule Protects Your Eyes',
    excerpt: 'Long hours on phones and laptops can leave your eyes tired and dry. A simple habit — the 20-20-20 rule — plus a few desk tweaks can make a real difference.',
    categorySlug: 'healthy-habits',
    tags: ['eye health', 'screen time', 'workplace wellness'],
    featured: true,
    daysAgo: 2,
    image: img('id-screen-habits'),
    imageAlt: 'Person working at a laptop beside a window',
    metaTitle: 'The 20-20-20 Rule: Healthy Screen Habits for Tired Eyes',
    metaDescription: 'Learn how the 20-20-20 rule, better lighting and regular breaks reduce digital eye strain — and when to talk to a doctor.',
    focusKeyword: '20-20-20 rule',
    body: `
<p>Most of us now spend the majority of our waking hours looking at a screen. Work, school, banking, entertainment and even doctor visits happen on phones and laptops. Screens don't permanently damage your eyes, but long, unbroken stretches of close-up focus often cause <strong>digital eye strain</strong>: tired, dry or burning eyes, blurred vision and headaches.</p>

<h2>Why screens tire your eyes</h2>
<p>When you look at something close, the small muscles inside your eye work to keep it in focus. Hold that position for hours and those muscles get fatigued. We also blink far less when we concentrate on a screen, so the surface of the eye dries out faster.</p>
<ul>
  <li>Glare from windows or overhead lights makes your eyes work harder.</li>
  <li>Screens that are too close, too bright or too dim add to the strain.</li>
  <li>Poor posture while looking down at a phone can bring on neck and shoulder pain too.</li>
</ul>

<h2>The 20-20-20 rule</h2>
<p>The easiest habit to build is the <mark>20-20-20 rule</mark>: <strong>every 20 minutes, look at something about 20 feet (6 metres) away for at least 20 seconds.</strong> This lets your focusing muscles relax. Many people set a gentle timer or use a break-reminder app until it becomes automatic.</p>
${figure('id-screen-window', 'A window view used as a distant focus point', 'A window makes an easy "20 feet away" target during your breaks.')}

<h2>Set up your screen for comfort</h2>
<ol>
  <li><strong>Distance:</strong> keep a computer screen roughly an arm's length away.</li>
  <li><strong>Height:</strong> the top of the screen should sit at or slightly below eye level.</li>
  <li><strong>Brightness:</strong> match screen brightness to the room — not much brighter or darker.</li>
  <li><strong>Text size:</strong> zoom in rather than leaning forward to read.</li>
  <li><strong>Blink:</strong> consciously blink fully a few times during each break.</li>
</ol>

<h3>Take longer breaks too</h3>
<p>Alongside the 20-second pauses, stand up and move for a few minutes every hour or two. It helps your eyes, back and circulation — see our guide to ${post('move-more-150-minutes-a-week', 'fitting 150 minutes of activity into your week')}.</p>

<blockquote>Small, regular breaks beat one long rest at the end of the day.</blockquote>

<h2>When to talk to a doctor</h2>
<p>Eye strain usually eases with rest. Speak to a doctor or eye specialist if you have eye pain, sudden changes in vision, flashes of light, persistent headaches, or symptoms that don't improve after adjusting your habits. The ${ext('https://www.aao.org/eye-health/tips-prevention/computer-usage', 'American Academy of Ophthalmology')} has more practical tips.</p>
<p>Not sure whether your symptoms need attention? You can talk to a licensed doctor on Instant Doctor by video or chat.</p>`,
  },
  {
    slug: 'blood-sugar-monitoring-basics',
    title: 'Blood Sugar Monitoring at Home: A Beginner’s Guide',
    excerpt: 'Checking your blood sugar shows how food, activity and medicine affect your body. Here is how to test accurately and what to do with the numbers.',
    categorySlug: 'chronic-disease-care',
    tags: ['diabetes', 'blood sugar', 'self-care'],
    daysAgo: 6,
    image: img('id-blood-sugar'),
    imageAlt: 'Blood glucose meter and test strips on a table',
    metaDescription: 'A practical guide to checking blood sugar at home: when to test, how to get accurate readings and when to call your doctor.',
    focusKeyword: 'blood sugar monitoring',
    body: `
<p>If you live with diabetes, regular blood sugar (glucose) checks are one of the most useful tools you have. Each reading is a snapshot that helps you and your doctor understand how meals, exercise, stress, illness and medication affect your levels.</p>

<h2>Who needs to check?</h2>
<p>How often you test depends on the type of diabetes you have and the treatment you're on. People using insulin usually test several times a day; others may test less often. <strong>Your doctor should set a testing plan and target range for you</strong> — targets differ from person to person.</p>

<h2>How to get an accurate reading</h2>
<ol>
  <li>Wash and dry your hands. Sugar on your fingers can give a falsely high result.</li>
  <li>Check that your test strips are in date and suit your meter.</li>
  <li>Prick the side of your fingertip — it's less painful than the pad.</li>
  <li>Apply the drop of blood to the strip as your meter's instructions describe.</li>
  <li>Write down or save the result with the time and what you'd recently eaten.</li>
</ol>
${figure('id-glucose-log', 'A notebook used as a blood sugar log', 'A simple log of readings, meals and medicine helps your doctor spot patterns.')}

<h2>Common testing times</h2>
<table>
  <thead><tr><th scope="col">When</th><th scope="col">What it tells you</th></tr></thead>
  <tbody>
    <tr><td>On waking (fasting)</td><td>Your baseline level overnight</td></tr>
    <tr><td>Before a meal</td><td>Your level going into the meal</td></tr>
    <tr><td>About 2 hours after a meal</td><td>How that meal affected you</td></tr>
    <tr><td>Before and after exercise</td><td>How activity lowers your sugar</td></tr>
    <tr><td>When you feel unwell</td><td>Whether symptoms are sugar-related</td></tr>
  </tbody>
</table>

<h2>Know the warning signs</h2>
<h3>Low blood sugar (hypoglycaemia)</h3>
<p>Shakiness, sweating, a fast heartbeat, hunger, confusion or irritability. Follow the plan your doctor gave you — usually a fast-acting sugar such as juice or glucose tablets — and recheck.</p>
<h3>High blood sugar (hyperglycaemia)</h3>
<p>Thirst, passing urine often, tiredness and blurred vision. Repeated high readings mean your treatment may need adjusting.</p>

<p><strong>Seek urgent care</strong> for confusion, fainting, vomiting, difficulty breathing or a reading that stays very high or very low despite treatment.</p>

<h2>Learn more</h2>
<p>Read the ${ext('https://www.who.int/news-room/fact-sheets/detail/diabetes', 'WHO diabetes fact sheet')}, and see how blood pressure fits into the picture in ${post('understanding-blood-pressure-numbers', 'Understanding your blood pressure numbers')}. If your readings worry you, a doctor on Instant Doctor can review them with you.</p>`,
  },
  {
    slug: 'understanding-blood-pressure-numbers',
    title: 'Understanding Your Blood Pressure Numbers',
    excerpt: 'High blood pressure often has no symptoms, so knowing your numbers matters. Here is what the top and bottom figures mean and how to measure at home.',
    categorySlug: 'heart-circulation',
    tags: ['blood pressure', 'hypertension', 'heart health'],
    daysAgo: 10,
    image: img('id-blood-pressure'),
    imageAlt: 'Blood pressure monitor cuff on an arm',
    metaDescription: 'What systolic and diastolic blood pressure mean, how to measure at home correctly, and simple steps to keep your numbers healthy.',
    focusKeyword: 'blood pressure numbers',
    body: `
<p>High blood pressure (hypertension) is sometimes called a "silent" condition: many people feel completely well while it quietly strains the heart, brain, kidneys and eyes. The ${ext('https://www.who.int/news-room/fact-sheets/detail/hypertension', 'World Health Organization')} notes that a large share of adults with hypertension don't know they have it. The only way to find out is to measure.</p>

<h2>What the two numbers mean</h2>
<ul>
  <li><strong>Systolic (top number):</strong> the pressure in your arteries when your heart beats.</li>
  <li><strong>Diastolic (bottom number):</strong> the pressure between beats, when the heart relaxes.</li>
</ul>
<p>A reading is written like <code>120/80 mmHg</code>. Your doctor will tell you what range is right for you, as targets depend on your age and other conditions.</p>

<h2>Measuring at home</h2>
${figure('id-bp-home', 'Person measuring their blood pressure at home', 'Home readings taken at the same times each day are the most useful.')}
<ol>
  <li>Avoid caffeine, smoking and exercise for 30 minutes before.</li>
  <li>Sit quietly for 5 minutes, back supported, feet flat on the floor.</li>
  <li>Rest your arm on a table with the cuff at heart level, on bare skin.</li>
  <li>Take two readings a minute apart and record both.</li>
</ol>

<h2>Habits that help</h2>
<ul>
  <li>Cut back on salt and heavily processed foods.</li>
  <li>Eat more vegetables, fruit, beans and whole grains — see our ${post('build-a-balanced-plate', 'balanced plate guide')}.</li>
  <li>Stay active most days of the week.</li>
  <li>Limit alcohol and stop smoking.</li>
  <li>Take prescribed medication every day, even when you feel fine.</li>
</ul>

<h2>When it's an emergency</h2>
<p><strong>A very high reading with chest pain, shortness of breath, a severe headache, confusion, weakness on one side or trouble speaking needs emergency care immediately.</strong> Don't wait to book an appointment.</p>
<p>For everyday questions about your readings or medication, a licensed doctor on Instant Doctor can help. The ${ext('https://www.nhs.uk/conditions/high-blood-pressure/', 'NHS guide to high blood pressure')} is another good resource.</p>`,
  },
  {
    slug: 'malaria-symptoms-when-to-get-tested',
    title: 'Malaria: Symptoms to Watch For and When to Get Tested',
    excerpt: 'Malaria can become serious quickly, but it is preventable and treatable. Learn the early signs, why testing matters, and how to protect your household.',
    categorySlug: 'seasonal-health',
    tags: ['malaria', 'fever', 'prevention'],
    daysAgo: 15,
    image: img('id-malaria'),
    imageAlt: 'Mosquito net hanging over a bed',
    metaDescription: 'Recognise early malaria symptoms, understand why testing before treatment matters, and protect your family with simple prevention steps.',
    focusKeyword: 'malaria symptoms',
    body: `
<p>Malaria is caused by a parasite spread through the bites of infected mosquitoes. It remains common in many parts of the world, especially during and after the rainy season. The good news: it is <strong>preventable and treatable</strong>, particularly when caught early.</p>

<h2>Early symptoms</h2>
<p>Symptoms usually start 10–15 days after an infected bite, though it can be longer. They can look like flu:</p>
<ul>
  <li>Fever, chills and sweating</li>
  <li>Headache and body aches</li>
  <li>Tiredness and weakness</li>
  <li>Nausea, vomiting or diarrhoea</li>
</ul>

<h2>Why you should test before treating</h2>
<p>Many illnesses cause fever, including typhoid, viral infections and urinary infections. Taking antimalarial medicine "just in case" can delay the right treatment and contributes to drug resistance. <strong>A rapid diagnostic test or blood smear confirms whether malaria is the cause</strong>, so you get the right medicine.</p>
${figure('id-lab-test', 'Laboratory technician preparing a blood test', 'A quick blood test confirms malaria before treatment begins.')}

<h2>Danger signs — get care immediately</h2>
<ul>
  <li>Confusion, drowsiness or seizures</li>
  <li>Difficulty breathing</li>
  <li>Repeated vomiting or being unable to drink</li>
  <li>Dark urine or very little urine</li>
  <li>Yellowing of the eyes or skin</li>
</ul>
<p>Young children, pregnant women and people with weakened immunity are at higher risk of severe malaria. For feverish children, also read ${post('fever-in-children-when-to-worry', 'Fever in children: when to worry')}.</p>

<h2>Prevention at home</h2>
<ol>
  <li>Sleep under an insecticide-treated mosquito net every night.</li>
  <li>Clear standing water around your home where mosquitoes breed.</li>
  <li>Use repellent and cover up in the evening.</li>
  <li>Ask a doctor about preventive medicine before travelling to high-risk areas.</li>
</ol>
<p>Learn more from the ${ext('https://www.who.int/news-room/fact-sheets/detail/malaria', 'WHO malaria fact sheet')} and the ${ext('https://www.nhs.uk/conditions/malaria/', 'NHS malaria guide')}. If you have a fever, a doctor on Instant Doctor can advise you on testing and next steps.</p>`,
  },
  {
    slug: 'fever-in-children-when-to-worry',
    title: 'Fever in Children: When to Worry and When to Wait',
    excerpt: 'Fever is a common sign that a child is fighting an infection. Here is how to keep them comfortable and the warning signs that mean you should get help.',
    categorySlug: 'child-family-health',
    tags: ['children', 'fever', 'parenting'],
    daysAgo: 21,
    image: img('id-child-fever'),
    imageAlt: 'Parent comforting a resting child',
    metaDescription: 'How to care for a child with a fever at home, and the warning signs that mean you should call a doctor or seek urgent care.',
    focusKeyword: 'fever in children',
    body: `
<p>Few things worry parents more than a hot, unhappy child. Fever itself is usually the body's normal response to infection, and most fevers in children are caused by common viral illnesses that get better on their own. Knowing what to watch for helps you act quickly when it matters.</p>

<h2>Caring for your child at home</h2>
<ul>
  <li>Offer plenty of fluids — water, breast milk or formula — to prevent dehydration.</li>
  <li>Dress them in light clothing; don't bundle them up.</li>
  <li>Let them rest, and check on them regularly, including overnight.</li>
  <li>Use fever medicine made for children only if they're distressed, at the dose on the label for their age and weight.</li>
</ul>
<p><strong>Never give aspirin to children</strong> unless a doctor specifically tells you to.</p>
${figure('id-thermometer', 'Digital thermometer', 'A digital thermometer gives the most reliable reading at home.')}

<h2>Get medical help urgently if your child</h2>
<ul>
  <li>Is under 3 months old and has a temperature of 38°C (100.4°F) or higher</li>
  <li>Is very drowsy, floppy or hard to wake</li>
  <li>Has a rash that doesn't fade when you press a glass against it</li>
  <li>Has difficulty breathing, or breathing that looks fast or noisy</li>
  <li>Has a seizure (fit)</li>
  <li>Shows signs of dehydration: few wet nappies, no tears, a dry mouth</li>
</ul>

<h2>Speak to a doctor soon if</h2>
<ul>
  <li>The fever lasts more than a few days</li>
  <li>Your child isn't drinking well or seems to be getting worse</li>
  <li>You live in or have travelled to an area with malaria — see ${post('malaria-symptoms-when-to-get-tested', 'our malaria guide')}</li>
  <li>You're worried — trust your instincts</li>
</ul>
<p>The ${ext('https://www.nhs.uk/conditions/fever-in-children/', 'NHS guide to fever in children')} has more detail. You can also talk to a doctor on Instant Doctor any time, day or night.</p>`,
  },
  {
    slug: 'better-sleep-habits',
    title: '7 Simple Habits for Better Sleep',
    excerpt: 'Good sleep supports your mood, immunity and focus. These practical habits can help you fall asleep faster and wake up more refreshed.',
    categorySlug: 'sleep-rest',
    tags: ['sleep', 'mental health', 'routine'],
    daysAgo: 28,
    image: img('id-better-sleep'),
    imageAlt: 'Calm bedroom with soft evening light',
    metaDescription: 'Seven practical sleep habits — from a steady schedule to a screen-free wind-down — to help you sleep better tonight.',
    focusKeyword: 'better sleep habits',
    body: `
<p>Sleep isn't a luxury. While you rest, your body repairs itself, your immune system recharges and your brain sorts the day's memories. Most adults need around 7–9 hours a night, yet many of us regularly get less. These habits can help.</p>

<h2>1. Keep a steady schedule</h2>
<p>Go to bed and get up at roughly the same time every day — weekends included. A regular rhythm trains your body clock.</p>

<h2>2. Create a wind-down routine</h2>
<p>Spend 30–60 minutes doing something calm: reading, a warm shower, gentle stretching or prayer and reflection.</p>

<h2>3. Put screens away</h2>
<p>Bright screens and constant notifications keep your brain alert. Try leaving your phone outside the bedroom. Our ${post('healthy-screen-habits-20-20-20-rule', 'healthy screen habits guide')} has more ideas.</p>
${figure('id-night-routine', 'Book and lamp on a bedside table', 'Swapping the phone for a book is an easy wind-down habit.')}

<h2>4. Make your room sleep-friendly</h2>
<p>Cool, dark and quiet works best. Curtains, a fan or earplugs can help.</p>

<h2>5. Watch caffeine and heavy meals</h2>
<p>Avoid coffee, energy drinks and strong tea from mid-afternoon, and leave a couple of hours between a large meal and bedtime.</p>

<h2>6. Get daylight and move</h2>
<p>Morning light and regular activity help set your body clock — just avoid hard exercise right before bed.</p>

<h2>7. Don't lie awake for hours</h2>
<p>If you can't sleep after about 20 minutes, get up, do something quiet in dim light, and return when you feel sleepy.</p>

<h2>When to see a doctor</h2>
<p>Talk to a doctor if poor sleep lasts more than a few weeks, if you snore loudly or stop breathing during sleep, or if tiredness affects your work, driving or mood. The ${ext('https://www.nhs.uk/every-mind-matters/mental-wellbeing-tips/how-to-fall-asleep-faster-and-sleep-better/', 'NHS Every Mind Matters')} site has more tips.</p>`,
  },
  {
    slug: 'move-more-150-minutes-a-week',
    title: 'Move More: How to Fit 150 Minutes of Activity Into Your Week',
    excerpt: 'Health guidelines recommend at least 150 minutes of moderate activity a week. That is just over 20 minutes a day — here is how to make it work.',
    categorySlug: 'fitness-exercise',
    tags: ['exercise', 'physical activity', 'heart health'],
    daysAgo: 35,
    image: img('id-move-more'),
    imageAlt: 'People walking outdoors on a sunny path',
    metaDescription: 'Simple ways to reach 150 minutes of moderate physical activity a week, even with a busy schedule.',
    focusKeyword: '150 minutes of exercise',
    body: `
<p>The ${ext('https://www.who.int/news-room/fact-sheets/detail/physical-activity', 'World Health Organization')} recommends that adults get at least <strong>150–300 minutes of moderate-intensity activity</strong> a week, plus muscle-strengthening activities on two or more days. Regular activity lowers the risk of heart disease, type 2 diabetes and high blood pressure, and it lifts your mood.</p>

<h2>What counts as "moderate"?</h2>
<p>Moderate activity raises your heart rate and makes you breathe faster, but you can still hold a conversation. Examples:</p>
<ul>
  <li>Brisk walking</li>
  <li>Cycling on flat ground</li>
  <li>Dancing</li>
  <li>Active household chores or gardening</li>
</ul>

<h2>Making it fit your week</h2>
<table>
  <thead><tr><th scope="col">Plan</th><th scope="col">How it adds up</th></tr></thead>
  <tbody>
    <tr><td>Daily walk</td><td>30 minutes × 5 days = 150 minutes</td></tr>
    <tr><td>Short bursts</td><td>3 × 10-minute walks a day, 5 days a week</td></tr>
    <tr><td>Weekend boost</td><td>2 × 45 minutes at weekends + 3 × 20 minutes on weekdays</td></tr>
  </tbody>
</table>
${figure('id-strength-training', 'Person doing a bodyweight squat at home', 'Bodyweight exercises at home count toward your strength days.')}

<h2>Tips to stay consistent</h2>
<ol>
  <li>Start small and build up gradually.</li>
  <li>Schedule activity like an appointment.</li>
  <li>Find something you enjoy — or a friend to do it with.</li>
  <li>Break up long periods of sitting, even with a 2-minute stretch.</li>
</ol>

<h2>Check with a doctor first if</h2>
<p>You have a heart condition, chest pain, dizziness, uncontrolled ${post('understanding-blood-pressure-numbers', 'blood pressure')} or diabetes, or you haven't been active for a long time. A quick consultation on Instant Doctor can help you start safely.</p>`,
  },
  {
    slug: 'build-a-balanced-plate',
    title: 'Build a Balanced Plate: Everyday Healthy Eating Made Simple',
    excerpt: 'Healthy eating does not need special diets. Use the balanced plate method to build nourishing meals from foods you already enjoy.',
    categorySlug: 'nutrition-diet',
    tags: ['nutrition', 'healthy eating', 'meal planning'],
    daysAgo: 42,
    image: img('id-balanced-plate'),
    imageAlt: 'Colourful plate of vegetables, grains and protein',
    metaDescription: 'Use the balanced plate method to build healthy, affordable meals: half vegetables, a quarter whole grains, a quarter protein.',
    focusKeyword: 'balanced plate',
    body: `
<p>You don't need expensive superfoods or strict diets to eat well. A simple visual guide — the <strong>balanced plate</strong> — works with local, everyday meals and helps you get the nutrients your body needs.</p>

<h2>The balanced plate</h2>
<ul>
  <li><strong>Half the plate: vegetables and fruit.</strong> Aim for a mix of colours — leafy greens, tomatoes, carrots, peppers, garden eggs.</li>
  <li><strong>A quarter: whole grains or starchy foods.</strong> Brown rice, whole-wheat bread, oats, yam, plantain or millet.</li>
  <li><strong>A quarter: protein.</strong> Beans, lentils, fish, eggs, chicken or lean meat.</li>
  <li><strong>Plus:</strong> water to drink, and a small amount of healthy oil.</li>
</ul>
${figure('id-healthy-meal', 'A home-cooked meal with vegetables and beans', 'Local, home-cooked meals can easily follow the balanced plate.')}

<h2>Easy swaps</h2>
<table>
  <thead><tr><th scope="col">Instead of</th><th scope="col">Try</th></tr></thead>
  <tbody>
    <tr><td>Sugary soft drinks</td><td>Water, or water with fresh fruit slices</td></tr>
    <tr><td>Fried snacks</td><td>Roasted groundnuts (unsalted) or fruit</td></tr>
    <tr><td>Extra salt at the table</td><td>Herbs, spices, pepper and lemon</td></tr>
    <tr><td>White bread</td><td>Whole-wheat bread or oats</td></tr>
  </tbody>
</table>

<h2>Small habits that add up</h2>
<ol>
  <li>Eat slowly and stop when you're comfortably full.</li>
  <li>Plan meals for the week to avoid last-minute fast food.</li>
  <li>Read labels for sugar and salt.</li>
  <li>Keep cut fruit and vegetables where you can see them.</li>
</ol>
<p>Eating less salt is one of the best things you can do for your ${post('understanding-blood-pressure-numbers', 'blood pressure')}, and balanced meals help keep ${post('blood-sugar-monitoring-basics', 'blood sugar')} steady. The ${ext('https://www.who.int/news-room/fact-sheets/detail/healthy-diet', 'WHO healthy diet fact sheet')} has more guidance.</p>
<p>Managing a condition like diabetes or high blood pressure? A doctor on Instant Doctor can give advice tailored to you.</p>`,
  },
];
