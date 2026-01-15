mod math;

use math::{add, Greeter};

fn main() {
    let g = Greeter { name: "world".to_string() };
    println!("{}", g.greet());

    let x = add(1, 2);
    println!("{}", x);
}
