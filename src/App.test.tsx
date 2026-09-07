import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App skeleton (Step0)', () => {
  it('renders the POC title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'HERE Map Matching POC' })).toBeTruthy()
  })

  it('mentions Step0 placeholder copy', () => {
    render(<App />)
    expect(screen.getByText(/Step0 scaffold/)).toBeTruthy()
  })
})
