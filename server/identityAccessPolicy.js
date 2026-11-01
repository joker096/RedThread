export function canInteract({ gender, status, environment }) {
  if (gender === 'female') return true;
  return gender === 'male' && status === 'verified' && environment === 'live';
}
