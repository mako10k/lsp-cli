pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn uses_add() -> i32 {
    add(10, 20)
}

pub struct Greeter {
    pub name: String,
}

impl Greeter {
    pub fn greet(&self) -> String {
        format!("hello {}", self.name)
    }
}
