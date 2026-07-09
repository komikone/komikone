/** Curated comic / superhero wallpapers — one picked at random on dashboard load. */
export const WALLPAPERS = [
  'https://images.unsplash.com/photo-1635805737707-575885ab0b74?w=1920&q=80',
  'https://images.unsplash.com/photo-1608889476561-6242cfdbf622?w=1920&q=80',
  'https://images.unsplash.com/photo-1612036789815-37j937d6f34e?w=1920&q=80',
  'https://images.unsplash.com/photo-1509347528160-9a9e33781cdb?w=1920&q=80',
  'https://images.unsplash.com/photo-1538485049706-74a7094e43f0?w=1920&q=80',
  'https://images.unsplash.com/photo-1531259683007-016a9b628c3f?w=1920&q=80',
  'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=1920&q=80',
  'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=1920&q=80',
];

export function pickWallpaper() {
  return WALLPAPERS[Math.floor(Math.random() * WALLPAPERS.length)];
}
