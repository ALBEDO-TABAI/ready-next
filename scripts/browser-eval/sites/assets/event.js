document.querySelector('#event-form')?.addEventListener('submit', event => {
  const place = event.target.querySelector('eval-field')
  if (!place) return
  event.target.elements.place.value = place.value
  event.target.elements.signup.value = event.target.querySelector('eval-switch').checked
    ? 'yes'
    : ''
})
