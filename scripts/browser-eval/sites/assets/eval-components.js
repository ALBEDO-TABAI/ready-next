class EvalField extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.id = this.getAttribute('name') || 'field'
    label.htmlFor = input.id
    label.textContent = `${this.getAttribute('label')} `
    label.append(input)
    root.append(label)
  }
  get value() {
    return this.shadowRoot.querySelector('input').value
  }
  set value(value) {
    this.shadowRoot.querySelector('input').value = value
  }
}
class EvalSwitch extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'switch')
    button.setAttribute('aria-checked', 'false')
    button.textContent = this.getAttribute('label')
    button.addEventListener('click', () => {
      this.checked = !this.checked
    })
    this.attachShadow({ mode: 'open' }).append(button)
  }
  get checked() {
    return this.shadowRoot.querySelector('button').getAttribute('aria-checked') === 'true'
  }
  set checked(value) {
    this.shadowRoot.querySelector('button').setAttribute('aria-checked', String(Boolean(value)))
  }
}
class EvalClosedButton extends HTMLElement {
  #root
  connectedCallback() {
    if (this.#root) return
    this.#root = this.attachShadow({ mode: 'closed' })
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = this.getAttribute('label')
    button.addEventListener('click', () => {
      document.querySelector('#shadow-result').textContent = '编号：SH-5521'
    })
    this.#root.append(button)
  }
}
customElements.define('eval-field', EvalField)
customElements.define('eval-switch', EvalSwitch)
customElements.define('eval-closed-button', EvalClosedButton)
