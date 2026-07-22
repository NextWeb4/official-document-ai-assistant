const storedTheme = localStorage.getItem('theme')
const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'dark'

document.documentElement.dataset.theme = theme
document.documentElement.classList.toggle('dark', theme === 'dark')
