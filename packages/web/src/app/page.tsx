import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Split shared costs to the penny.</h1>
      <p>Add what everyone paid. Penny works out the fewest payments to settle up, exact to the last cent.</p>
      <div>
        <Link href="/new" className="button" data-testid="home-start">
          Start a group
        </Link>
      </div>
    </main>
  );
}
