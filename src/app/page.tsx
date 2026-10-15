import { redirect } from 'next/navigation'

/** `/` is a plain redirect — the real entry pages are /dashboard (signed in)
 *  and /login (signed out; the (app) guard sends visitors there). */
export default function Home() {
  redirect('/dashboard')
}
